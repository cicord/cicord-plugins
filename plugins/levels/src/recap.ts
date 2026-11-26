import type { Context, Json } from "@cicord/sdk";
import { dayOf, type Standing } from "./levels.ts";

type Page = { day: string; cursor?: string; best: Standing[] };
export async function collect(ctx: Context, input?: Json) {
  if (!ctx.config.enabled) return;
  const state = (input ?? { day: dayOf(new Date(Date.now() - 86400000)), best: [] }) as Page;
  const prefix = "day:" + state.day + ":";
  const batch = await ctx.kv.list<number>({ prefix, cursor: state.cursor, limit: 500 });
  const best = [
    ...state.best,
    ...batch.items
      .filter((e) => e.value > 0)
      .map((e) => ({ userId: e.key.slice(prefix.length), xp: e.value })),
  ]
    .sort((a, b) => b.xp - a.xp || (a.userId < b.userId ? -1 : 1))
    .slice(0, ctx.config.recap.top);
  if (batch.cursor) {
    await ctx.schedule.after(1, "recap-page", { day: state.day, best, cursor: batch.cursor });
    return;
  }
  const channel = ctx.config.recap.channel ?? ctx.config.announce.channel;
  if (ctx.config.recap.enabled && channel && best.length) {
    const receipt = "recap:" + state.day;
    // Reserve before sending so a replay can never duplicate the daily summary.
    if (
      (
        await ctx.kv
          .atomic()
          .check(receipt, null)
          .set(receipt, true, { ttlSeconds: 7 * 86400 })
          .commit()
      ).ok
    ) {
      const posted = await ctx.server.channel(channel).send({
        embeds: [
          {
            title: ctx.i18n.t("recap", { date: state.day }),
            description: best
              .map(
                (s, i) => `${["🥇", "🥈", "🥉"][i] ?? "#" + (i + 1)} <@${s.userId}> — +${s.xp} XP`,
              )
              .join("\n"),
            color: "#f1c40f",
          },
        ],
        allowedMentions: { users: false },
      });
      for (const p of best)
        await ctx.kv.set("copy:" + p.userId + ":" + posted.id, {
          channelId: posted.channel.id,
          messageId: posted.id,
          kind: "recap",
        });
    }
  }
  await prune(ctx, { day: state.day });
}
export async function prune(ctx: Context, input: Json | undefined) {
  const day = (input as { day: string }).day;
  const batch = await ctx.kv.list({ prefix: "day:" + day + ":", limit: 100 });
  if (!batch.items.length) return;
  const tx = ctx.kv.atomic();
  for (const item of batch.items) tx.delete(item.key);
  await tx.commit();
  if (batch.cursor) await ctx.schedule.after(5, "recap-prune", { day });
}
