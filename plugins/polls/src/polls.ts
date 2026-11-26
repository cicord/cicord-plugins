import type { PollClosedV1 } from "./contracts.ts";
/** Poll records, tallies and rendering, independent of the handlers. */
import type { ActionRow, Context, Json, Message, MessagePayload } from "@cicord/sdk";

type PollStyle = "buttons" | "select" | "native";

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
  status: "scheduled" | "open" | "closed";
  maxChoices?: number;
  anonymous?: boolean;
  eligibleRoles?: string[];
  weights?: { role: string; weight: number }[];
  hours?: number;
  final?: { counts: number[]; voterCount: number };
  published?: boolean;
  closing?: boolean;
  closedAt?: string;
  closedBy?: string | null;
}

export interface Tally {
  counts: number[];
  voters: string[];
  voterCount?: number;
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

/** A single-choice count needs only Discord's answer totals. Multiselect
 * participants can appear on several pages and on more than one answer. */
export async function nativeTally(message: Message, includeVoterIds: boolean): Promise<Tally> {
  if (!message.poll) throw new Error("Discord poll results are unavailable");
  const counts = message.poll.answers.map((a) => a.votes);
  const total = counts.reduce((n, v) => n + v, 0);
  if (!includeVoterIds && !message.poll.multiselect) {
    return { counts, voters: [], voterCount: total };
  }
  const ids = new Set<string>();
  for (const answer of message.poll.answers) {
    if (!answer.votes) continue;
    let after: string | undefined;
    for (;;) {
      const page = await message.pollVoters(answer.id, after);
      for (const id of page) ids.add(id);
      if (page.length < 100) break;
      after = page.at(-1);
    }
  }
  return {
    counts,
    voterCount: message.poll.multiselect ? ids.size : total,
    voters: includeVoterIds ? [...ids].sort() : [],
  };
}

/** Counts votes (one KV key per voter, so concurrent votes never overwrite each other). */
export async function tally(ctx: Context, poll: Poll): Promise<Tally> {
  if (poll.final)
    return { counts: poll.final.counts, voters: [], voterCount: poll.final.voterCount };
  if (poll.style === "native") {
    if (poll.status === "scheduled")
      return { counts: poll.choices.map(() => 0), voters: [], voterCount: 0 };
    const message = await findMessage(ctx, poll.channelId, poll.messageId);
    if (!message?.poll) throw new Error("Discord poll results are unavailable");
    return nativeTally(message, false);
  }
  const counts = poll.choices.map(() => 0);
  const voters: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await ctx.kv.list<number[] | { choices: number[]; weight: number }>({
      prefix: `vote:${poll.id}:`,
      limit: 1000,
      ...(cursor ? { cursor } : {}),
    });
    for (const { key, value } of page.items) {
      const picks = Array.isArray(value) ? value : value.choices;
      const weight = Array.isArray(value) ? 1 : value.weight;
      if (!picks?.length) continue;
      voters.push(key.slice(key.lastIndexOf(":") + 1));
      for (const i of picks) if (i >= 0 && i < counts.length) counts[i] = (counts[i] ?? 0) + weight;
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

export function renderPoll(poll: Poll, t: Tally, ctx: Context): MessagePayload {
  const total = t.counts.reduce((a, b) => a + b, 0);
  const max = Math.max(0, ...t.counts);
  const open = poll.status === "open";
  const voters = t.voterCount ?? t.voters.length;
  const lines = poll.choices.map((label, i) => {
    const n = t.counts[i] ?? 0;
    const share = total > 0 ? n / total : 0;
    const win = !open && n > 0 && n === max ? " 🏆" : "";
    return `**${i + 1}. ${label}**${win}\n\`${bar(share)}\` ${ctx.i18n.t(n === 1 ? "oneVote" : "votes", { n })} (${Math.round(share * 100)}%)`;
  });
  const closes = Math.floor(Date.parse(poll.closesAt) / 1000);
  const footer = open
    ? ctx.i18n.t(poll.multiple ? "manyChoices" : "oneChoice", { time: `<t:${closes}:R>` })
    : ctx.i18n.t(voters === 1 ? "oneVoter" : "voters", { n: voters });
  return {
    embeds: [
      {
        title: `📊 ${poll.question}`,
        description: `${lines.join("\n\n")}\n\n${footer}`,
        color: ctx.config.color,
        footer: { text: ctx.i18n.t("number", { id: poll.id }) },
      },
    ],
    components: open ? components(poll, ctx) : [],
  };
}

function components(poll: Poll, ctx: Context): ActionRow[] {
  const rows: ActionRow[] = [];
  if (poll.style === "select") {
    rows.push({
      type: "row",
      components: [
        {
          type: "select",
          id: `pick:${poll.id}`,
          placeholder: ctx.i18n.t(poll.multiple ? "pickMany" : "pickOne"),
          minValues: 1,
          maxValues: poll.multiple ? (poll.maxChoices ?? poll.choices.length) : 1,
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
      {
        type: "button",
        id: `end:${poll.id}`,
        label: ctx.i18n.t("end"),
        emoji: "🔒",
        style: "danger",
      },
    ],
  });
  return rows;
}

export function closedEvent(poll: Poll, t: Tally): PollClosedV1 {
  const max = Math.max(0, ...t.counts);
  return {
    pollId: poll.id,
    question: poll.question,
    choices: poll.choices.map((label, i) => ({ label, votes: t.counts[i] ?? 0 })),
    winners: max > 0 ? poll.choices.filter((_, i) => t.counts[i] === max) : [],
    voters: poll.anonymous ? [] : t.voters,
    closedBy: poll.anonymous ? null : (poll.closedBy ?? null),
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
