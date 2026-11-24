/** Poll records, tallies and rendering, independent of the handlers. */
import type { ActionRow, Context, Json, Message, MessagePayload } from "@cicord/sdk";

type PollStyle = "buttons" | "select";

/** Stored under `poll:<id>`. */
export interface Poll {
  id: string;
  question: string;
  choices: string[];
  multiple: boolean;
  style: PollStyle;
  authorId: string;
  channelId: string;
  messageId: string;
  createdAt: string;
  closesAt: string;
  /** Scheduled closing task (ctx.schedule.after). */
  taskId?: string;
  status: "open" | "closed";
  closedAt?: string;
  closedBy?: string | null;
}

export interface Tally {
  counts: number[];
  voters: string[];
}

/** Payload of the `polls.closed` event. */
export interface PollClosed {
  pollId: string;
  question: string;
  choices: { label: string; votes: number }[];
  winners: string[];
  voters: string[];
  closedBy: string | null;
  channelId: string;
  messageId: string;
}

export const MAX_CHOICES = 10;

const pollKey = (id: string): string => `poll:${id}`;
export const voteKey = (id: string, userId: string): string => `vote:${id}:${userId}`;

/** "Pizza | Sushi; Tacos" → ["Pizza", "Sushi", "Tacos"] (also one per line). */
export function parseChoices(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[|;\n]/)) {
    const label = part.trim().slice(0, 80);
    if (label && !seen.has(label.toLowerCase())) {
      seen.add(label.toLowerCase());
      out.push(label);
    }
  }
  return out;
}

export async function getPoll(ctx: Context, id: string): Promise<Poll | undefined> {
  return (await ctx.kv.get(pollKey(id))) as Poll | undefined;
}

export async function savePoll(ctx: Context, poll: Poll): Promise<void> {
  await ctx.kv.set(pollKey(poll.id), poll as unknown as Json);
}

/** Counts votes (one KV key per voter, so concurrent votes never overwrite each other). */
export async function tally(ctx: Context, poll: Poll): Promise<Tally> {
  const counts = poll.choices.map(() => 0);
  const voters: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await ctx.kv.list<number[]>({
      prefix: `vote:${poll.id}:`,
      limit: 1000,
      ...(cursor ? { cursor } : {}),
    });
    for (const { key, value } of page.items) {
      if (!Array.isArray(value) || value.length === 0) continue;
      voters.push(key.slice(key.lastIndexOf(":") + 1));
      for (const i of value) if (i >= 0 && i < counts.length) counts[i] = (counts[i] ?? 0) + 1;
    }
    cursor = page.cursor;
  } while (cursor);
  return { counts, voters };
}

const BAR = 12;

function bar(share: number): string {
  const full = Math.round(share * BAR);
  return "█".repeat(full) + "░".repeat(BAR - full);
}

export function renderPoll(poll: Poll, t: Tally, color: string): MessagePayload {
  const total = t.counts.reduce((a, b) => a + b, 0);
  const max = Math.max(0, ...t.counts);
  const open = poll.status === "open";
  const lines = poll.choices.map((label, i) => {
    const n = t.counts[i] ?? 0;
    const share = total > 0 ? n / total : 0;
    const win = !open && n > 0 && n === max ? " 🏆" : "";
    return `**${i + 1}. ${label}**${win}\n\`${bar(share)}\` ${n} vote${n === 1 ? "" : "s"} (${Math.round(share * 100)}%)`;
  });
  const closes = Math.floor(Date.parse(poll.closesAt) / 1000);
  const footer = open
    ? `${poll.multiple ? "Several choices allowed" : "One choice"} · closes <t:${closes}:R>`
    : `Closed · ${t.voters.length} voter${t.voters.length === 1 ? "" : "s"}`;
  return {
    embeds: [
      {
        title: `📊 ${poll.question}`,
        description: `${lines.join("\n\n")}\n\n${footer}`,
        color,
        footer: { text: `Poll #${poll.id}` },
      },
    ],
    components: open ? components(poll) : [],
  };
}

function components(poll: Poll): ActionRow[] {
  const rows: ActionRow[] = [];
  if (poll.style === "select") {
    rows.push({
      type: "row",
      components: [
        {
          type: "select",
          id: `pick:${poll.id}`,
          placeholder: poll.multiple ? "Pick one or more" : "Pick one",
          minValues: 1,
          maxValues: poll.multiple ? poll.choices.length : 1,
          options: poll.choices.map((label, i) => ({ value: String(i), label })),
        },
      ],
    });
  } else {
    for (let i = 0; i < poll.choices.length; i += 5) {
      rows.push({
        type: "row",
        components: poll.choices.slice(i, i + 5).map((label, k) => ({
          type: "button" as const,
          id: `vote:${poll.id}:${i + k}`,
          label: `${i + k + 1}. ${label}`.slice(0, 80),
          style: "secondary" as const,
        })),
      });
    }
  }
  rows.push({
    type: "row",
    components: [
      { type: "button", id: `end:${poll.id}`, label: "Close poll", emoji: "🔒", style: "danger" },
    ],
  });
  return rows;
}

export function closedEvent(poll: Poll, t: Tally): PollClosed {
  const max = Math.max(0, ...t.counts);
  return {
    pollId: poll.id,
    question: poll.question,
    choices: poll.choices.map((label, i) => ({ label, votes: t.counts[i] ?? 0 })),
    winners: max > 0 ? poll.choices.filter((_, i) => t.counts[i] === max) : [],
    voters: t.voters,
    closedBy: poll.closedBy ?? null,
    channelId: poll.channelId,
    messageId: poll.messageId,
  };
}

/** Finds the message of a poll (undefined when it was deleted). */
export async function findMessage(
  ctx: Context,
  channelId: string,
  messageId: string,
): Promise<Message | undefined> {
  return ctx.server.channel({ id: channelId }).message(messageId);
}

/** Every poll, newest first. */
export async function listPolls(ctx: Context): Promise<Poll[]> {
  const polls: Poll[] = [];
  let cursor: string | undefined;
  do {
    const page = await ctx.kv.list({
      prefix: "poll:",
      limit: 1000,
      ...(cursor ? { cursor } : {}),
    });
    for (const { value } of page.items) polls.push(value as unknown as Poll);
    cursor = page.cursor;
  } while (cursor);
  return polls.toSorted((a, b) => Number(b.id) - Number(a.id));
}

/**
 * Autocomplete suggestions: the polls whose number or question contains what was typed
 * (at most 25, Discord's limit). The value is the poll number.
 */
export function suggestPolls(polls: Poll[], typed: string): { name: string; value: string }[] {
  const q = typed.trim().replace(/^#/, "").toLowerCase();
  return polls
    .filter((p) => q === "" || p.id.startsWith(q) || p.question.toLowerCase().includes(q))
    .slice(0, 25)
    .map((p) => ({ name: `#${p.id} ${p.question}`.slice(0, 100), value: p.id }));
}
