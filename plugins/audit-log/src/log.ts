/** Log entries, the batch queue and the rendering of a batch. Independent of the handlers. */
import type { Context, Embed, Json, MessagePayload } from "@cicord/sdk";

/** Where an entry goes (config `channels.<group>`, else `channel`). */
type Group = "members" | "messages" | "plugins";

export interface Entry {
  /** Epoch ms. */
  at: number;
  group: Group;
  icon: string;
  text: string;
}

const QUEUE = "q:";
const PENDING = "pending";
const SEQ = "seq";
const DESCRIPTION_MAX = 3800; // Discord: 4096 per embed description, 6000 per message
const LINE_MAX = 600;

const COLORS: Record<Group, string> = {
  members: "#3498db",
  messages: "#95a5a6",
  plugins: "#e67e22",
};

/** Escapes Markdown in user-provided names (embeds never ping, but formatting would leak). */
export function esc(s: string): string {
  return s.replace(/([\\*_~`|>[\]()])/g, "\\$1");
}

/** Creation time of a Discord id (snowflake), in epoch ms. Float precision is enough here. */
export function snowflakeTime(id: string): number {
  return Math.floor(Number(id) / 4_194_304) + 1_420_070_400_000;
}

export const ts = (ms: number, style = "R"): string => `<t:${Math.floor(ms / 1000)}:${style}>`;

export function messageLink(serverId: string, channelId: string, messageId: string): string {
  return `https://discord.com/channels/${serverId}/${channelId}/${messageId}`;
}

function line(e: Entry): string {
  const text = e.text.length > LINE_MAX ? `${e.text.slice(0, LINE_MAX - 1)}…` : e.text;
  return `${ts(e.at, "T")} ${e.icon} ${text}`;
}

/**
 * Messages for a batch of entries of one channel: compact embeds, one line per event, cut
 * so that each message stays under Discord's size limits.
 */
export function render(entries: Entry[], dropped = 0): MessagePayload[] {
  const lines = entries.map(line);
  if (dropped > 0)
    lines.push(`⚠️ …and ${dropped} more event${dropped === 1 ? "" : "s"} not posted (rate limit).`);
  const groups = new Set(entries.map((e) => e.group));
  const color = groups.size === 1 ? COLORS[[...groups][0] as Group] : "#7f8c8d";
  const chunks: string[][] = [];
  let current: string[] = [];
  let size = 0;
  for (const l of lines) {
    if (current.length > 0 && size + l.length + 1 > DESCRIPTION_MAX) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(l);
    size += l.length + 1;
  }
  if (current.length > 0) chunks.push(current);
  return chunks.map((c) => {
    const embed: Embed = { description: c.join("\n"), color };
    return { embeds: [embed], allowedMentions: { users: false, roles: false, everyone: false } };
  });
}

function channelFor(ctx: Context, group: Group): string {
  return ctx.config.channels?.[group] ?? ctx.config.channel;
}

/** Posts entries now, grouped by destination channel. */
async function post(ctx: Context, entries: Entry[], dropped = 0): Promise<void> {
  const byChannel = new Map<string, Entry[]>();
  for (const e of entries) {
    const key = channelFor(ctx, e.group);
    byChannel.set(key, [...(byChannel.get(key) ?? []), e]);
  }
  let first = true;
  for (const [key, list] of byChannel) {
    // The dropped count goes once, with the first channel's batch.
    const messages = render(list, first ? dropped : 0);
    first = false;
    const channel = ctx.server.channel(key);
    for (const m of messages) {
      try {
        await channel.send(m);
      } catch (error) {
        ctx.log.warn("audit-log: could not post to the log channel", {
          channel: key,
          error: String(error),
        });
        break;
      }
    }
  }
}

/**
 * Logs an entry: queued in KV and posted by the `flush` task `batchSeconds` later (one
 * task per batch: the first entry of a batch schedules it), or posted right away when
 * batching is off.
 */
export async function record(ctx: Context, entry: Omit<Entry, "at">): Promise<void> {
  const full: Entry = { ...entry, at: Date.now() };
  if (ctx.config.batchSeconds === 0) {
    await post(ctx, [full]);
    return;
  }
  const n = await ctx.kv.increment(SEQ);
  // A day-long TTL: a lost flush never keeps entries forever.
  await ctx.kv.set(`${QUEUE}${String(n).padStart(12, "0")}`, full as unknown as Json, {
    ttlSeconds: 86_400,
  });
  if ((await ctx.kv.increment(PENDING)) === 1)
    await ctx.schedule.after(ctx.config.batchSeconds * 1000, "flush");
}

/** Posts the queued entries (at most `maxPerBatch`; the others are counted and dropped). */
export async function flush(ctx: Context, olderThanMs?: number): Promise<number> {
  if (olderThanMs !== undefined) {
    // Sweep: only a batch whose flush task was lost (older than a batch should get).
    const { items } = await ctx.kv.list({ prefix: QUEUE, limit: 1 });
    const oldest = (items[0]?.value as unknown as Entry | undefined)?.at;
    if (oldest === undefined || Date.now() - oldest < olderThanMs) return 0;
  }
  // Reset before reading: an entry recorded from now on schedules the next flush, and an
  // entry recorded meanwhile is either read below or flushed by that next task.
  await ctx.kv.set(PENDING, 0);
  const { items } = await ctx.kv.list({ prefix: QUEUE, limit: 1000 });
  if (items.length === 0) return 0;
  for (const { key } of items) await ctx.kv.delete(key);
  // More than one page queued (a raid): the rest goes with the next batch.
  if (items.length === 1000 && (await ctx.kv.increment(PENDING)) === 1)
    await ctx.schedule.after(ctx.config.batchSeconds * 1000, "flush");
  const entries = items.map((i) => i.value as unknown as Entry);
  const max = ctx.config.maxPerBatch;
  await post(ctx, entries.slice(0, max), Math.max(0, entries.length - max));
  return entries.length;
}
