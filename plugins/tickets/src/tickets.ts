/**
 * Ticket records and helpers, independent of the handlers. The `GET /tickets` shape is
 * consumed by the community portal (keep `TicketSummary` stable).
 */
import type { Context, Embed, Json, Member, MessagePayload, User } from "@cicord/sdk";

type TicketStatus = "open" | "closed";

export interface Person {
  id: string;
  displayName: string;
}

/** Stored under `ticket:<padded number>`. */
export interface Ticket {
  id: string;
  number: number;
  subject: string;
  description: string;
  status: TicketStatus;
  author: Person;
  channelId: string;
  createdAt: string;
  closedAt?: string;
  closedBy?: Person;
  /** Filled when the ticket is closed. */
  summary?: { messages: number; participants: Person[] };
}

/** One item of `GET /tickets`. */
export interface TicketSummary {
  id: string;
  subject: string;
  status: TicketStatus;
  author: Person;
  createdAt: string;
  closedAt: string | null;
  channelId: string | null;
  messages: number;
  lastActivityAt: string | null;
}

// Zero-padded numbers keep `kv.list()` (lexicographic) in ticket order.
const ticketKey = (n: number): string => `ticket:${String(n).padStart(8, "0")}`;
export const openKey = (userId: string, n: number): string => `open:${userId}:${n}`;
export const channelKey = (channelId: string): string => `channel:${channelId}`;
export const activityKey = (n: number): string => `activity:${n}`;
export const lastActivityKey = (n: number): string => `last:${n}`;

export function person(user: User, member?: Member): Person {
  return { id: user.id, displayName: member?.displayName ?? user.displayName };
}

/** Replaces `{name}` placeholders; unknown ones are kept as is. */
export function render(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (all, name: string) => vars[name] ?? all);
}

/** Discord channel names: lowercase, no spaces, at most 100 characters. */
export function channelName(template: string, n: number, member: string): string {
  const name = render(template, { number: String(n), member })
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
  return (name || `ticket-${n}`).slice(0, 100);
}

export async function getTicket(ctx: Context, n: number): Promise<Ticket | undefined> {
  return (await ctx.kv.get(ticketKey(n))) as Ticket | undefined;
}

export async function saveTicket(ctx: Context, t: Ticket): Promise<void> {
  await ctx.kv.set(ticketKey(t.number), t as unknown as Json);
}

/** Numbers of the member's open tickets. */
export async function openTickets(ctx: Context, userId: string): Promise<number[]> {
  const { items } = await ctx.kv.list({ prefix: `open:${userId}:`, limit: 100 });
  return items.map((i) => Number(i.key.slice(i.key.lastIndexOf(":") + 1)));
}

/** Parses the ticket number carried by a component id (`close:42` → 42). */
export function numberOf(componentId: string): number | undefined {
  const n = Number(componentId.slice(componentId.indexOf(":") + 1));
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

export function isStaff(ctx: Context, member: Member | undefined): boolean {
  return !!member && ctx.config.staffRoles.some((r) => member.hasRole(r));
}

export function panelMessage(ctx: Context): MessagePayload {
  const { title, description, buttonLabel, color } = ctx.config.panel;
  return {
    embeds: [{ title, description, color }],
    components: [
      {
        type: "row",
        components: [
          { type: "button", id: "open", label: buttonLabel, emoji: "🎫", style: "primary" },
        ],
      },
    ],
  };
}

export function closeButton(n: number): MessagePayload["components"] {
  return [
    {
      type: "row",
      components: [
        { type: "button", id: `close:${n}`, label: "Close", emoji: "🔒", style: "danger" },
      ],
    },
  ];
}

export function summaryEmbed(t: Ticket): Embed {
  const minutes = Math.max(
    1,
    Math.round((Date.parse(t.closedAt ?? t.createdAt) - Date.parse(t.createdAt)) / 60_000),
  );
  const participants = t.summary?.participants ?? [];
  return {
    title: `Ticket #${t.number} closed — ${t.subject}`,
    description: t.description || undefined,
    color: "#95a5a6",
    fields: [
      { name: "Opened by", value: `<@${t.author.id}>`, inline: true },
      { name: "Closed by", value: t.closedBy ? `<@${t.closedBy.id}>` : "—", inline: true },
      { name: "Duration", value: formatMinutes(minutes), inline: true },
      { name: "Messages", value: String(t.summary?.messages ?? 0), inline: true },
      {
        name: "Participants",
        value: participants.length > 0 ? participants.map((p) => `<@${p.id}>`).join(" ") : "—",
        inline: true,
      },
    ],
    timestamp: t.closedAt,
  };
}

function formatMinutes(m: number): string {
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ${m % 60} min`;
  return `${Math.floor(h / 24)} days`;
}

export async function listTickets(
  ctx: Context,
  status: string | undefined,
): Promise<TicketSummary[]> {
  const tickets: Ticket[] = [];
  let cursor: string | undefined;
  do {
    const page = await ctx.kv.list({
      prefix: "ticket:",
      limit: 1000,
      ...(cursor ? { cursor } : {}),
    });
    for (const item of page.items) tickets.push(item.value as unknown as Ticket);
    cursor = page.cursor;
  } while (cursor);
  const out: TicketSummary[] = [];
  for (const t of tickets.toReversed()) {
    if (status && t.status !== status) continue;
    const open = t.status === "open";
    out.push({
      id: t.id,
      subject: t.subject,
      status: t.status,
      author: t.author,
      createdAt: t.createdAt,
      closedAt: t.closedAt ?? null,
      channelId: open ? t.channelId : null,
      messages: open
        ? ((await ctx.kv.get<number>(activityKey(t.number))) ?? 0)
        : (t.summary?.messages ?? 0),
      lastActivityAt: (await ctx.kv.get<string>(lastActivityKey(t.number))) ?? null,
    });
  }
  return out;
}
