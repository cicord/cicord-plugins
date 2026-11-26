import type { Context, Json, Message } from "@cicord/sdk";
import { adKey, renderScheduled, deliveryReference, type Scheduled } from "./messages.ts";
import { send } from "./community.ts";

function ownReceipt(ctx: Context, m: Message, id: number): boolean {
  // Match both published locales; changing the config language must preserve delivery identity.
  return (
    m.author.id === ctx.bot.user.id &&
    ["en", "fr"].some((locale) =>
      m.embeds.some(
        (embed) =>
          embed.footer?.text ===
          ctx.i18n.t("receipt", { id, instance: ctx.plugin.instance }, { locale }),
      ),
    )
  );
}

/** Retry a scheduled send after a crash, including interruptions beyond Discord's nonce window. */
export async function post(ctx: Context, payload: Json | undefined) {
  const id = Number((payload as { id?: number } | undefined)?.id),
    key = adKey(id);
  const entry = await ctx.kv.getEntry(key),
    s = entry?.value as unknown as Scheduled | undefined;
  if (!s || !entry || ctx.config.enabled === false) return;
  const channel = ctx.server.channel({ id: s.channelId });
  if (s.sendingSince && Date.now() - s.sendingSince > 120000) {
    if (s.layout)
      throw Error(
        "Unconfirmed Components V2 delivery after the Discord nonce window. Review the destination before replay.",
      );
    if (!ctx.features.enabled("recoverPosts"))
      throw Error("Scheduled post needs discord.messages.read to reconcile an unconfirmed send.");
    let before = s.scanBefore;
    for (let page = 0; page < 3; page++) {
      const messages = await channel.messages({ limit: 100, ...(before ? { before } : {}) });
      if (messages.some((m) => ownReceipt(ctx, m, id))) {
        await ctx.kv
          .atomic()
          .check(key, entry.version)
          .delete(key)
          .increment("stats:posted", 1)
          .commit();
        return;
      }
      const last = messages.at(-1);
      if (!last || messages.length < 100 || last.createdAt.getTime() < s.sendingSince - 5000) {
        before = undefined;
        break;
      }
      before = last.id;
    }
    if (before) {
      const continuation = await ctx.schedule.after(1000, "post", { id });
      if (
        !(
          await ctx.kv
            .atomic()
            .check(key, entry.version)
            .set(key, { ...s, scanBefore: before, taskId: continuation.id } as unknown as Json)
            .commit()
        ).ok
      )
        await ctx.schedule.cancel(continuation.id);
      return;
    }
  }
  s.sendingSince = Date.now();
  delete s.scanBefore;
  if (
    !(
      await ctx.kv
        .atomic()
        .check(key, entry.version)
        .set(key, s as unknown as Json)
        .commit()
    ).ok
  )
    return;
  const msg = renderScheduled(ctx, s);
  if (msg.embeds?.[0]) msg.embeds[0].footer = { text: deliveryReference(ctx, id) };
  await send(ctx, channel, { ...msg, nonce: "a" + id, enforceNonce: true });
  await ctx.kv.atomic().delete(key).increment("stats:posted", 1).commit();
}
