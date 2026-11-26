import type { Context, Json } from "@cicord/sdk";
import { dayKey, dayOf, levelOf, xpKey } from "./levels.ts";

type Receipt = { xp: number; previous: number; level: number };
const ttl = 30 * 86400;
export class ConcurrentReaction extends Error {}
export type ReactionChange = {
  key: string;
  version: string | null;
  value: { emojis: string[]; amount: number };
};
export function activeArchive(ctx: Context) {
  const s = ctx.config.season;
  return s?.id && s.end && Date.parse(s.end) <= Date.now() ? s.id : undefined;
}
export async function credit(
  ctx: Context,
  uid: string,
  amount: number,
  id: string,
  absolute = false,
  reaction?: ReactionChange,
): Promise<Receipt> {
  if (!Number.isSafeInteger(amount)) throw new Error("Invalid XP amount");
  const receipt = "award:" + uid + ":" + id,
    k = xpKey(uid);
  for (;;) {
    const hit = await ctx.kv.get<Receipt>(receipt);
    if (hit) return hit;
    if (reaction && ((await ctx.kv.getEntry(reaction.key))?.version ?? null) !== reaction.version)
      throw new ConcurrentReaction();
    const old = await ctx.kv.getEntry<number>(k),
      archive = activeArchive(ctx),
      mark = archive ? `archived:${uid}:${archive}` : "";
    const marker = mark ? await ctx.kv.getEntry(mark) : undefined,
      rolling = !!mark && !marker;
    const prior = rolling ? 0 : (old?.value ?? 0),
      xp = Math.max(0, absolute ? amount : prior + amount);
    if (!Number.isSafeInteger(xp)) throw new Error("XP exceeds safe integer range");
    const res = { xp, previous: levelOf(prior), level: levelOf(xp) };
    const tx = ctx.kv
      .atomic()
      .check(k, old?.version ?? null)
      .check(receipt, null)
      .set(k, xp)
      .set(receipt, res, { ttlSeconds: ttl });
    if (reaction)
      tx.check(reaction.key, reaction.version).set(reaction.key, reaction.value, {
        ttlSeconds: 7 * 86400,
      });
    if (rolling) {
      tx.check(mark, null).set(mark, old?.value ?? 0);
      if (old?.value) tx.rankSet("season:" + archive, uid, old.value);
    }
    if (xp > 0) tx.rankSet("xp", uid, xp);
    else tx.rankRemove("xp", uid);
    if (xp > prior) tx.increment(dayKey(dayOf(new Date()), uid), xp - prior);
    if ((await tx.commit()).ok) return res;
  }
}
export async function migrate(ctx: Context) {
  if (!ctx.config.enabled || (await ctx.kv.get("meta:schema")) === 2) return;
  const position = await ctx.kv.getEntry<string>("meta:cursor");
  const page = await ctx.kv.list({ prefix: "xp:", limit: 1000, cursor: position?.value });
  // Check each source revision in the same transaction as its index write. A live award
  // writes both sides atomically and can never be overwritten by a stale migration read.
  for (let start = 0; start < page.items.length; start += 25) {
    const slice = page.items.slice(start, start + 25);
    for (;;) {
      const tx = ctx.kv.atomic();
      for (const { key } of slice) {
        const source = await ctx.kv.getEntry<number>(key);
        tx.check(key, source?.version ?? null);
        if (source?.value && source.value > 0) tx.rankSet("xp", key.slice(3), source.value);
        else tx.rankRemove("xp", key.slice(3));
      }
      if ((await tx.commit()).ok) break;
    }
  }
  const tx = ctx.kv.atomic().check("meta:cursor", position?.version ?? null);
  if (page.cursor) tx.set("meta:cursor", page.cursor);
  else tx.delete("meta:cursor").set("meta:schema", 2);
  if ((await tx.commit()).ok && page.cursor) await ctx.schedule.after(1, "migrate-ranking");
}
export async function seasonBatch(ctx: Context, p: Json | undefined) {
  const season = activeArchive(ctx);
  if (!ctx.config.enabled || !season || (await ctx.kv.get("season:" + season))) return;
  const { cursor } = (p as { cursor?: string }) ?? {};
  const page = await ctx.kv.list({ prefix: "xp:", limit: 100, cursor });
  for (const { key } of page.items) await credit(ctx, key.slice(3), 0, "season:" + season);
  if (page.cursor) await ctx.schedule.after(1, "season", { cursor: page.cursor });
  else await ctx.kv.set("season:" + season, true);
}
export async function importCsv(ctx: Context, p: Json | undefined) {
  const file = ctx.config.importFile;
  if (
    !ctx.config.enabled ||
    !file ||
    !ctx.features.enabled("importCsv") ||
    (await ctx.kv.get("import:" + file))
  )
    return;
  const rows = (await ctx.files.read(file)).split(/\r?\n/),
    offset = Number((p as { offset?: number })?.offset ?? 0);
  for (let i = offset; i < Math.min(rows.length, offset + 100); i++) {
    const line = rows[i]!.trim();
    if (!line || (i === 0 && line === "userId,xp")) continue;
    const match = /^([1-9][0-9]{0,19}),([0-9]{1,15})$/.exec(line);
    if (!match) throw new Error("Invalid XP CSV row " + (i + 1));
    await credit(ctx, match[1]!, Number(match[2]), "import:" + file + ":" + i, true);
  }
  if (rows.length > offset + 100)
    await ctx.schedule.after(1, "import-csv", { offset: offset + 100 });
  else await ctx.kv.set("import:" + file, true);
}
export async function personal(ctx: Context, uid: string, erase: boolean) {
  const result: { key: string; value: Json }[] = [];
  let cursor: string | undefined;
  const ownedMessages = new Set<string>();
  do {
    const page = await ctx.kv.list({ prefix: "msg:", limit: 1000, cursor });
    for (const row of page.items) if (row.value === uid) ownedMessages.add(row.key.slice(4));
    cursor = page.cursor;
  } while (cursor);
  do {
    const page = await ctx.kv.list({ limit: 1000, cursor });
    for (const row of page.items) {
      const [kind, a, b] = row.key.split(":");
      const owned =
        (["xp", "user", "cooldown", "voice", "archived", "award", "notice", "copy"].includes(
          kind!,
        ) &&
          a === uid) ||
        (kind === "day" && b === uid) ||
        (kind === "msg" && row.value === uid) ||
        ((kind === "react" || kind === "reaction") && (b === uid || ownedMessages.has(a!)));
      if (owned) {
        result.push(row);
        if (erase) {
          if (kind === "copy") {
            const copy = row.value as { channelId: string; messageId: string; kind: string };
            if (!ctx.features.enabled("privacyCopies"))
              throw new Error("Grant discord.messages.read to erase published level announcements");
            const m = await ctx.server.channel({ id: copy.channelId }).message(copy.messageId);
            if (m && m.author.id === ctx.bot.user.id) {
              if (copy.kind === "level")
                await m.edit({
                  content: ctx.i18n.t("erased"),
                  embeds: [],
                  components: [],
                  allowedMentions: { users: [] },
                });
              else {
                const embed = m.embeds[0];
                if (embed)
                  await m.edit({
                    embeds: [
                      {
                        ...embed,
                        description:
                          (embed.description ?? "")
                            .split("\n")
                            .filter((line) => !line.includes("<@" + uid + ">"))
                            .join("\n") || "—",
                      },
                    ],
                    allowedMentions: { users: [] },
                  });
              }
            }
          }
          await ctx.kv.delete(row.key);
          if (kind === "archived") await ctx.kv.ranking("season:" + b).remove(uid);
        }
      }
    }
    cursor = page.cursor;
  } while (cursor);
  if (erase) await ctx.kv.ranking("xp").remove(uid);
  return result;
}
