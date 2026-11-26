import type { Context, Json } from "@cicord/sdk";
import { dayKey, dayOf, levelOf, xpKey } from "./levels.ts";

/**
 * The highest level a member has reached, per season. A level is a business fact crossed
 * once: reaction toggles, `/xp remove` then `/xp give`, and replays never cross it again.
 * A season reset (the member's archive roll) starts a new mark tagged with that season.
 */
export type Peak = { level: number; season?: string };
/** Set in the receipt of the award that crossed a level, so a replay repeats its effects. */
export type Crossing = { level: number; previous: number; season?: string };
export type Receipt = {
  xp: number;
  previous: number;
  level: number;
  /** Receipts written before 0.2.0's high-water mark: never replayed as a crossing. */
  eventId?: string;
  crossed?: Crossing;
};
const ttl = 30 * 86400;
export const WEEK = 7 * 86400;
export const peakKey = (uid: string) => "peak:" + uid;
export const receiptKey = (uid: string, id: string) => "award:" + uid + ":" + id;
/** Per-member index of references whose key starts with a message id (privacy hooks). */
export const authoredIndex = (uid: string, messageId: string) => "by:" + uid + ":msg:" + messageId;
export const reactedIndex = (uid: string, messageId: string) => "by:" + uid + ":gave:" + messageId;
export class ConcurrentReaction extends Error {}
export type ReactionChange = {
  key: string;
  version: string | null;
  value: { emojis: string[]; amount: number; award?: string };
  /** Reactor-side privacy index written with the reaction record. */
  index: string;
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
  const receipt = receiptKey(uid, id),
    k = xpKey(uid),
    pk = peakKey(uid);
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
    // Members from before the mark existed have reached at least their current level.
    const stored = await ctx.kv.getEntry<Peak>(pk);
    const base: Peak = rolling
      ? { level: 0, season: archive }
      : {
          level: Math.max(stored?.value.level ?? 0, levelOf(prior)),
          ...(stored?.value.season ? { season: stored.value.season } : {}),
        };
    const level = levelOf(xp);
    const res: Receipt = { xp, previous: levelOf(prior), level };
    if (level > base.level)
      res.crossed = {
        level,
        previous: base.level,
        ...(base.season ? { season: base.season } : {}),
      };
    const tx = ctx.kv
      .atomic()
      .check(k, old?.version ?? null)
      .check(receipt, null)
      .check(pk, stored?.version ?? null)
      .set(k, xp)
      .set(receipt, res, { ttlSeconds: ttl });
    const peak: Peak = { ...base, level: Math.max(base.level, level) };
    if (
      rolling ||
      peak.level !== (stored?.value.level ?? 0) ||
      (peak.season ?? null) !== (stored?.value.season ?? null)
    )
      tx.set(pk, peak);
    if (reaction)
      tx.check(reaction.key, reaction.version)
        .set(reaction.key, { ...reaction.value, award: id }, { ttlSeconds: WEEK })
        .set(reaction.index, true, { ttlSeconds: WEEK });
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
type ImportPage = { offset?: number; invalid?: number; rows?: number[] };
/**
 * `userId,xp` rows, 100 per task. A malformed row is skipped and reported, never retried:
 * the import completes and the status line lists the first invalid row numbers.
 */
export async function importCsv(ctx: Context, p: Json | undefined) {
  const file = ctx.config.importFile;
  if (
    !ctx.config.enabled ||
    !file ||
    !ctx.features.enabled("importCsv") ||
    (await ctx.kv.get("import:" + file))
  )
    return;
  let text: string;
  try {
    text = await ctx.files.read(file);
  } catch (error) {
    ctx.status.set("import-csv", `Cannot read ${file}: ${String(error)}`.slice(0, 300));
    return;
  }
  const rows = text.split(/\r?\n/),
    page = (p ?? {}) as ImportPage,
    offset = Number(page.offset ?? 0);
  let invalid = page.invalid ?? 0;
  const bad = [...(page.rows ?? [])];
  for (let i = offset; i < Math.min(rows.length, offset + 100); i++) {
    const line = rows[i]!.trim();
    if (!line || (i === 0 && line === "userId,xp")) continue;
    const match = /^([1-9][0-9]{0,19}),([0-9]{1,15})$/.exec(line);
    if (!match) {
      invalid++;
      if (bad.length < 10) bad.push(i + 1);
      continue;
    }
    await credit(ctx, match[1]!, Number(match[2]), "import:" + file + ":" + i, true);
  }
  if (rows.length > offset + 100) {
    await ctx.schedule.after(1, "import-csv", { offset: offset + 100, invalid, rows: bad });
    return;
  }
  await ctx.kv.set("import:" + file, true);
  ctx.status.set(
    "import-csv",
    invalid
      ? `${file} imported; ${invalid} invalid rows skipped (rows ${bad.join(", ")}${invalid > bad.length ? ", …" : ""}). Expected userId,xp.`.slice(
          0,
          300,
        )
      : null,
  );
}
type Row = { key: string; value: Json };
/** Every row of one prefix (the prefixes here are all scoped to one member or message). */
async function rowsOf(ctx: Context, prefix: string, out: Row[]) {
  let cursor: string | undefined;
  do {
    const page = await ctx.kv.list({ prefix, limit: 1000, cursor });
    out.push(...page.items);
    cursor = page.cursor;
  } while (cursor);
}
/** Days whose `day:` counters may still exist (the recap prunes yesterday's every morning). */
const RECENT_DAYS = 14;
/**
 * The member's rows, found through member-scoped keys and the `by:<uid>:` index only. Rows
 * keyed by message id (`msg:`, `reaction:`, legacy `react:`) are reached through the index
 * written with them. Rows written before the index existed expire on their own (seven-day
 * TTL, in 0.1 too).
 *
 * `references` are other members' rows that point at this member: the reactions they gave
 * to the member's messages. They are another member's data, so an export leaves them out
 * (minimal data), and an erasure deletes them with the messages they reference.
 */
async function memberRows(ctx: Context, uid: string): Promise<{ rows: Row[]; references: Row[] }> {
  const rows: Row[] = [];
  const references: Row[] = [];
  const exact = [
    xpKey(uid),
    "user:" + uid,
    "cooldown:" + uid,
    "voice:" + uid,
    peakKey(uid),
    pendingKey(uid),
  ];
  for (let d = 0; d < RECENT_DAYS; d++)
    exact.push(dayKey(dayOf(new Date(Date.now() - d * 86400000)), uid));
  const values = await ctx.kv.getMany(exact);
  exact.forEach((key, i) => {
    if (values[i] !== undefined) rows.push({ key, value: values[i]! });
  });
  for (const kind of ["award", "notice", "copy", "archived"])
    await rowsOf(ctx, kind + ":" + uid + ":", rows);
  const index: Row[] = [];
  await rowsOf(ctx, "by:" + uid + ":", index);
  rows.push(...index);
  for (const { key } of index) {
    const [, , kind, messageId] = key.split(":");
    if (!messageId) continue;
    if (kind === "msg") {
      const author = await ctx.kv.get("msg:" + messageId);
      if (author === uid) rows.push({ key: "msg:" + messageId, value: author });
      // Reactions others gave to the member's message reference it (indexed messages are
      // never older than the `reaction:` layout, so there is no legacy `react:` row).
      await rowsOf(ctx, "reaction:" + messageId + ":", references);
    } else if (kind === "gave") {
      const own = "reaction:" + messageId + ":" + uid,
        value = await ctx.kv.get(own);
      if (value !== undefined) rows.push({ key: own, value });
      await rowsOf(ctx, "react:" + messageId + ":" + uid + ":", rows);
    }
  }
  const seen = new Set<string>();
  const unique = (list: Row[]) => list.filter((r) => !seen.has(r.key) && !!seen.add(r.key));
  return { rows: unique(rows), references: unique(references) };
}
type Copy = { channelId: string; messageId: string; kind: string };
/** Erased member whose published copies still await redaction (drives the status line). */
const pendingKey = (uid: string) => "pending-copies:" + uid;
/** Redacts one published announcement or recap row. False: it must be kept for a retry. */
async function redact(ctx: Context, uid: string, copy: Copy): Promise<boolean> {
  try {
    const m = await ctx.server.channel({ id: copy.channelId }).message(copy.messageId);
    if (!m || m.author.id !== ctx.bot.user.id) return true;
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
    return true;
  } catch (error) {
    ctx.log.warn("levels: announcement redaction failed", { error: String(error) });
    return false;
  }
}
export async function personal(ctx: Context, uid: string, erase: boolean) {
  const { rows: own, references } = await memberRows(ctx, uid);
  if (!erase) return own;
  const rows = [...own, ...references];
  const erased: Row[] = [];
  let kept = 0;
  const copies = ctx.features.enabled("privacyCopies");
  const deletions: string[] = [];
  for (const row of rows) {
    const [kind, , season] = row.key.split(":");
    if (kind === "copy" && !(copies && (await redact(ctx, uid, row.value as Copy)))) {
      // Kept only to redact the public message once discord.messages.read is granted.
      kept++;
      continue;
    }
    if (kind === "archived") await ctx.kv.ranking("season:" + season).remove(uid);
    deletions.push(row.key);
    erased.push(row);
  }
  for (let i = 0; i < deletions.length; i += 100) {
    const tx = ctx.kv.atomic();
    for (const key of deletions.slice(i, i + 100)) tx.delete(key);
    await tx.commit();
  }
  await ctx.kv.ranking("xp").remove(uid);
  if (kept) await ctx.kv.set(pendingKey(uid), kept);
  // Cleared only when no erased member has copies left, whoever was erased last.
  const pending = (await ctx.kv.list({ prefix: "pending-copies:", limit: 1 })).items.length;
  ctx.status.set(
    "privacy-copies",
    pending
      ? "Published level-up or recap messages of erased members could not be redacted. Grant discord.messages.read (feature privacyCopies) and repeat their erasure."
      : null,
  );
  return erased;
}
