/**
 * Ticket records and the operations shared by the Discord handlers and the portal routes
 * (open, close, reopen, reply…). The portal shapes are declared in routes.ts.
 *
 * Nothing here stores what people write in a ticket channel: only the subject and details
 * of the opening form, the close reason, who did what and when.
 */
import type {
  Context,
  Embed,
  Json,
  Member,
  MessagePayload,
  Permission,
  TextChannel,
  User,
} from "@cicord/sdk";
import type {
  Label,
  MyTicket,
  MyTicketDetail,
  Person,
  Priority,
  StaffTicket,
  StaffTicketDetail,
  TicketEvent,
  TicketEventType,
  TicketMessage,
  TicketSource,
  TicketStatus,
} from "./routes.ts";

export type { Person } from "./routes.ts";

export const PRIORITIES: readonly Priority[] = ["low", "normal", "high", "urgent"];
const MAX_EVENTS = 100;

/** Stored under `ticket:<padded number>`. */
export interface Ticket {
  id: string;
  number: number;
  subject: string;
  description: string;
  status: TicketStatus;
  author: Person;
  /** The current (or last) channel of the ticket. */
  channelId: string;
  createdAt: string;
  closedAt?: string;
  closedBy?: Person;
  /** Filled when the ticket is closed. */
  summary?: { messages: number; participants: Person[] };
  // 0.2 fields: `normalize` gives older records their defaults.
  priority: Priority;
  /** Key of a configured label. */
  label: string | null;
  assignee: Person | null;
  /** The last 100 events. */
  events: TicketEvent[];
  source: TicketSource;
  closeReason?: string;
  /** The channel was deleted when the ticket was closed. */
  channelRemoved?: boolean;
}

// Zero-padded numbers keep `kv.list()` (lexicographic) in ticket order.
const pad = (n: number): string => String(n).padStart(8, "0");
const ticketKey = (n: number): string => `ticket:${pad(n)}`;
export const openKey = (userId: string, n: number): string => `open:${userId}:${n}`;
export const channelKey = (channelId: string): string => `channel:${channelId}`;
export const activityKey = (n: number): string => `activity:${n}`;
export const lastActivityKey = (n: number): string => `last:${n}`;
/** Index of a member's tickets (`GET /tickets/mine`). */
const authorKey = (userId: string, n: number): string => `author:${userId}:${pad(n)}`;
/** Set once the author index covers the tickets written before 0.2. */
const AUTHOR_INDEX = "index:authors";
/** Members seen acting as staff (`GET /staff`): the SDK cannot list a role's members. */
const staffKey = (userId: string): string => `staff:${userId}`;

const TICKET_PERMS: Permission[] = [
  "ViewChannel",
  "SendMessages",
  "ReadMessageHistory",
  "AttachFiles",
  "EmbedLinks",
];

const NO_MENTIONS = { users: false, roles: false, everyone: false } as const;

export function person(user: User, member?: Member): Person {
  return { id: user.id, displayName: member?.displayName ?? user.displayName };
}

/** Replaces `{name}` placeholders; unknown ones are kept as is. */
export function render(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (all, name: string) => vars[name] ?? all);
}

/** A display name shown as plain text inside bot messages. */
export function escapeMarkdown(text: string): string {
  return text.replace(/[\\*_~`|>]/g, (c) => `\\${c}`);
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

export function channelUrl(ctx: Context, t: Ticket): string | null {
  return t.status === "open"
    ? `https://discord.com/channels/${ctx.server.id}/${t.channelId}`
    : null;
}

/** Gives a record written by an older version the 0.2 defaults. */
export function normalize(raw: Ticket): Ticket {
  const events: TicketEvent[] = Array.isArray(raw.events)
    ? raw.events
    : [
        { type: "opened", at: raw.createdAt, by: raw.author, detail: "discord" },
        ...(raw.status === "closed" && raw.closedAt
          ? [{ type: "closed" as const, at: raw.closedAt, by: raw.closedBy ?? raw.author }]
          : []),
      ];
  return {
    ...raw,
    priority: PRIORITIES.includes(raw.priority) ? raw.priority : "normal",
    label: typeof raw.label === "string" ? raw.label : null,
    assignee: raw.assignee ?? null,
    events,
    source: raw.source === "portal" ? "portal" : "discord",
  };
}

export function addEvent(
  t: Ticket,
  type: TicketEventType,
  by: Person,
  detail?: string,
  at = new Date().toISOString(),
): void {
  const event: TicketEvent = { type, at, by, ...(detail !== undefined ? { detail } : {}) };
  t.events = [...t.events, event].slice(-MAX_EVENTS);
}

export async function getTicket(ctx: Context, n: number): Promise<Ticket | undefined> {
  const raw = (await ctx.kv.get(ticketKey(n))) as unknown as Ticket | undefined;
  return raw ? normalize(raw) : undefined;
}

export async function saveTicket(ctx: Context, t: Ticket): Promise<void> {
  await ctx.kv.set(ticketKey(t.number), t as unknown as Json);
}

async function allTickets(ctx: Context): Promise<Ticket[]> {
  const tickets: Ticket[] = [];
  let cursor: string | undefined;
  do {
    const page = await ctx.kv.list({
      prefix: "ticket:",
      limit: 1000,
      ...(cursor ? { cursor } : {}),
    });
    for (const item of page.items) tickets.push(normalize(item.value as unknown as Ticket));
    cursor = page.cursor;
  } while (cursor);
  return tickets;
}

/** Numbers of the member's open tickets. */
export async function openTickets(ctx: Context, userId: string): Promise<number[]> {
  const { items } = await ctx.kv.list({ prefix: `open:${userId}:`, limit: 100 });
  return items.map((i) => Number(i.key.slice(i.key.lastIndexOf(":") + 1)));
}

/** Every ticket of a member, from the author index (built once from older records). */
async function authorTickets(ctx: Context, userId: string): Promise<Ticket[]> {
  if (!(await ctx.kv.get(AUTHOR_INDEX))) {
    for (const t of await allTickets(ctx)) await ctx.kv.set(authorKey(t.author.id, t.number), true);
    await ctx.kv.set(AUTHOR_INDEX, true);
  }
  const out: Ticket[] = [];
  let cursor: string | undefined;
  do {
    const page = await ctx.kv.list({
      prefix: `author:${userId}:`,
      limit: 1000,
      ...(cursor ? { cursor } : {}),
    });
    for (const item of page.items) {
      const t = await getTicket(ctx, Number(item.key.slice(item.key.lastIndexOf(":") + 1)));
      if (t && t.author.id === userId) out.push(t);
    }
    cursor = page.cursor;
  } while (cursor);
  return out;
}

/** Parses the ticket number carried by a component id (`close:42` → 42). */
export function numberOf(componentId: string): number | undefined {
  const n = Number(componentId.slice(componentId.indexOf(":") + 1));
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** A staff role, the server owner or a Cicord admin. An unknown access level never counts. */
export function isStaff(ctx: Context, member: Member | undefined): boolean {
  if (!member) return false;
  if (member.access === "admin") return true;
  if (ctx.server.ownerId !== undefined && member.id === ctx.server.ownerId) return true;
  return ctx.config.staffRoles.some((r) => member.hasRole(r));
}

/** Remembers a staff member for `GET /staff` (written only when new or renamed). */
export async function rememberStaff(ctx: Context, p: Person): Promise<void> {
  const known = await ctx.kv.get<{ id: string; displayName: string }>(staffKey(p.id));
  if (known?.displayName !== p.displayName)
    await ctx.kv.set(staffKey(p.id), { id: p.id, displayName: p.displayName });
}

/** Staff members seen so far that still are staff (each one checked on Discord). */
export async function listStaff(ctx: Context): Promise<Person[]> {
  const { items } = await ctx.kv.list<{ id: string; displayName: string }>({
    prefix: "staff:",
    limit: 100,
  });
  const out: Person[] = [];
  for (const { key, value } of items) {
    const member = await ctx.server.member(value.id);
    if (!member || !isStaff(ctx, member)) {
      await ctx.kv.delete(key);
      continue;
    }
    const p = person(member.user, member);
    if (p.displayName !== value.displayName) await ctx.kv.set(key, { ...p });
    out.push(p);
  }
  return out.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

// ───────────────────────────────────────────────────────────── labels

export function labelOf(ctx: Context, key: string | null): Label | null {
  if (key === null) return null;
  const l = ctx.config.labels.find((x) => x.key === key);
  // A label removed from the config stays readable on the tickets that have it.
  return l ? { key: l.key, name: l.name, emoji: l.emoji ?? null } : { key, name: key, emoji: null };
}

export function isLabel(ctx: Context, key: string): boolean {
  return ctx.config.labels.some((l) => l.key === key);
}

// ───────────────────────────────────────────────────────────── messages

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

function ticketEmbed(ctx: Context, t: Ticket): Embed {
  const label = labelOf(ctx, t.label);
  return {
    title: `#${t.number} — ${t.subject}`,
    description: t.description || "_No details._",
    color: ctx.config.panel.color,
    ...(label
      ? {
          fields: [
            { name: "Label", value: `${label.emoji ? `${label.emoji} ` : ""}${label.name}` },
          ],
        }
      : {}),
  };
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
      ...(t.closeReason ? [{ name: "Reason", value: t.closeReason }] : []),
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

/** The ticket channel, or undefined when it is gone (`channel()` throws for unknown ones). */
export function ticketChannel(ctx: Context, t: Ticket): TextChannel | undefined {
  if (t.channelRemoved) return undefined;
  try {
    return ctx.server.channel({ id: t.channelId });
  } catch {
    return undefined;
  }
}

/** Posts a short notice in an open ticket's channel; a failure is logged, not thrown. */
export async function notice(ctx: Context, t: Ticket, content: string): Promise<void> {
  if (t.status !== "open") return;
  try {
    const channel = ticketChannel(ctx, t);
    if (channel) await channel.send({ content, allowedMentions: NO_MENTIONS });
  } catch (error) {
    ctx.log.warn("tickets: could not post in the ticket channel", {
      ticket: t.number,
      error: String(error),
    });
  }
}

// ───────────────────────────────────────────────────────────── operations

/** Private channel of a ticket: the member, the staff roles and the bot. */
async function createTicketChannel(
  ctx: Context,
  t: Pick<Ticket, "number" | "subject" | "author">,
): Promise<TextChannel> {
  // Keys: "@everyone", a role key, "role:<id>" or "member:<id>".
  const overwrites: Record<string, { allow?: Permission[]; deny?: Permission[] }> = {
    "@everyone": { deny: ["ViewChannel"] },
    [`member:${t.author.id}`]: { allow: [...TICKET_PERMS] },
    // The bot keeps access even without Administrator.
    [`member:${ctx.bot.user.id}`]: { allow: [...TICKET_PERMS, "ManageChannels"] },
  };
  for (const role of ctx.config.staffRoles) overwrites[role] = { allow: [...TICKET_PERMS] };
  return ctx.server.createChannel({
    name: channelName(ctx.config.channelName, t.number, t.author.displayName),
    ...(ctx.config.category ? { category: ctx.config.category } : {}),
    topic: `#${t.number} · ${t.subject} · opened by ${t.author.displayName}`,
    overwrites,
  });
}

/** Opens a ticket: channel, records, welcome message. The caller checks the limit. */
export async function openTicket(
  ctx: Context,
  input: {
    user: User;
    member: Member | undefined;
    subject: string;
    description: string;
    label: string | null;
    source: TicketSource;
  },
): Promise<{ ticket: Ticket; channel: TextChannel }> {
  const author = person(input.user, input.member);
  const number = await ctx.kv.increment("seq");
  const channel = await createTicketChannel(ctx, { number, subject: input.subject, author });
  const now = new Date().toISOString();
  const ticket: Ticket = {
    id: String(number),
    number,
    subject: input.subject,
    description: input.description,
    status: "open",
    author,
    channelId: channel.id,
    createdAt: now,
    priority: "normal",
    label: input.label,
    assignee: null,
    events: [],
    source: input.source,
  };
  addEvent(ticket, "opened", author, input.source, now);
  await saveTicket(ctx, ticket);
  await ctx.kv.set(openKey(author.id, number), true);
  await ctx.kv.set(channelKey(channel.id), number);
  await ctx.kv.set(authorKey(author.id, number), true);
  await ctx.kv.increment("stats:opened");

  const staff =
    ctx.config.staffRoles.map((r) => ctx.server.role(r).mention).join(" ") || "The team";
  await channel.send({
    content: render(ctx.config.welcomeMessage, {
      member: input.user.mention,
      staff,
      subject: input.subject,
      number: String(number),
    }),
    embeds: [ticketEmbed(ctx, ticket)],
    components: closeButton(number),
    allowedMentions: { users: true, roles: true },
  });
  ctx.log.info("ticket opened", {
    ticket: number,
    member: author.id,
    channel: channel.id,
    source: input.source,
  });
  return { ticket, channel };
}

/**
 * Closes a ticket: participants and message count for the summary (read, not stored), the
 * summary in the staff log, then the channel is deleted.
 */
export async function closeTicket(
  ctx: Context,
  ticket: Ticket,
  by: Person,
  reason?: string,
): Promise<Ticket> {
  const participants = new Map<string, Person>();
  let messages = 0;
  try {
    const channel = ticketChannel(ctx, ticket);
    for (const m of channel ? await channel.messages({ limit: 100 }) : []) {
      if (m.author.bot) continue;
      messages++;
      participants.set(m.author.id, person(m.author, m.member));
    }
  } catch (error) {
    ctx.log.warn("tickets: could not read the ticket history", {
      ticket: ticket.number,
      error: String(error),
    });
  }

  const closed: Ticket = {
    ...ticket,
    status: "closed",
    closedAt: new Date().toISOString(),
    closedBy: by,
    summary: { messages, participants: [...participants.values()] },
  };
  delete closed.closeReason;
  if (reason) closed.closeReason = reason;
  addEvent(closed, "closed", by, reason, closed.closedAt);
  await saveTicket(ctx, closed);
  await ctx.kv.delete(openKey(ticket.author.id, ticket.number));
  await ctx.kv.delete(channelKey(ticket.channelId));
  await ctx.kv.delete(activityKey(ticket.number));
  await ctx.kv.increment("stats:closed");

  if (ctx.config.logChannel) {
    await ctx.server.channel(ctx.config.logChannel).send({
      embeds: [summaryEmbed(closed)],
      allowedMentions: NO_MENTIONS,
    });
  }
  try {
    await ctx.server.deleteChannel({ id: ticket.channelId }, `ticket #${ticket.number} closed`);
    closed.channelRemoved = true;
    await saveTicket(ctx, closed);
  } catch (error) {
    ctx.log.warn("tickets: could not delete the ticket channel", {
      ticket: ticket.number,
      error: String(error),
    });
  }
  ctx.log.info("ticket closed", { ticket: ticket.number, by: by.id, messages });
  return closed;
}

/** Reopens a closed ticket, in a new channel when the old one was deleted. */
export async function reopenTicket(ctx: Context, ticket: Ticket, by: Person): Promise<Ticket> {
  const channel = ticketChannel(ctx, ticket) ?? (await createTicketChannel(ctx, ticket));
  const reopened: Ticket = { ...ticket, status: "open", channelId: channel.id };
  delete reopened.closedAt;
  delete reopened.closedBy;
  delete reopened.closeReason;
  delete reopened.summary;
  delete reopened.channelRemoved;
  addEvent(reopened, "reopened", by);
  await saveTicket(ctx, reopened);
  await ctx.kv.set(openKey(ticket.author.id, ticket.number), true);
  await ctx.kv.set(channelKey(channel.id), ticket.number);
  // Keep counting from the messages of the first round.
  await ctx.kv.set(activityKey(ticket.number), ticket.summary?.messages ?? 0);

  await channel.send({
    content: `<@${ticket.author.id}> Reopened by **${escapeMarkdown(by.displayName)}**.`,
    embeds: [ticketEmbed(ctx, reopened)],
    components: closeButton(ticket.number),
    allowedMentions: { users: [ticket.author.id], roles: false, everyone: false },
  });
  ctx.log.info("ticket reopened", { ticket: ticket.number, by: by.id, channel: channel.id });
  return reopened;
}

/** Posts a staff message from the portal in the ticket channel. Returns its id. */
export async function postReply(
  ctx: Context,
  ticket: Ticket,
  by: Person,
  content: string,
): Promise<string> {
  const channel = ticketChannel(ctx, ticket);
  if (!channel) throw new Error(`ticket #${ticket.number} has no channel`);
  const message = await channel.send({
    embeds: [
      {
        description: content,
        color: ctx.config.panel.color,
        footer: { text: `— ${by.displayName} (via portal)` },
      },
    ],
    allowedMentions: NO_MENTIONS,
  });
  addEvent(ticket, "replied", by, message.id);
  await saveTicket(ctx, ticket);
  await ctx.kv.increment(activityKey(ticket.number));
  await ctx.kv.set(lastActivityKey(ticket.number), message.createdAt.toISOString());
  return message.id;
}

// ───────────────────────────────────────────────────────────── portal views

async function activity(
  ctx: Context,
  t: Ticket,
): Promise<{ messages: number; last: string | null }> {
  return {
    messages:
      t.status === "open"
        ? ((await ctx.kv.get<number>(activityKey(t.number))) ?? 0)
        : (t.summary?.messages ?? 0),
    last: (await ctx.kv.get<string>(lastActivityKey(t.number))) ?? null,
  };
}

export async function staffView(ctx: Context, t: Ticket): Promise<StaffTicket> {
  const a = await activity(ctx, t);
  return {
    id: t.id,
    subject: t.subject,
    status: t.status,
    author: t.author,
    createdAt: t.createdAt,
    closedAt: t.closedAt ?? null,
    channelId: t.status === "open" ? t.channelId : null,
    messages: a.messages,
    lastActivityAt: a.last,
    number: t.number,
    priority: t.priority,
    label: labelOf(ctx, t.label),
    assignee: t.assignee,
    source: t.source,
  };
}

/** Everything about a ticket, with its channel's last 50 messages read from Discord. */
export async function staffDetail(ctx: Context, t: Ticket): Promise<StaffTicketDetail> {
  const { messages, channelId: _current, ...view } = await staffView(ctx, t);
  let history: TicketMessage[] | null = null;
  try {
    const channel = ticketChannel(ctx, t);
    if (channel) {
      history = (await channel.messages({ limit: 50 })).toReversed().map((m) => ({
        id: m.id,
        author: { ...person(m.author, m.member), bot: m.author.bot },
        content: m.content,
        createdAt: m.createdAt.toISOString(),
      }));
    }
  } catch (error) {
    ctx.log.warn("tickets: could not read the ticket channel", {
      ticket: t.number,
      error: String(error),
    });
  }
  return {
    ...view,
    description: t.description,
    channelId: t.channelId,
    channelUrl: channelUrl(ctx, t),
    closedBy: t.closedBy ?? null,
    closeReason: t.closeReason ?? null,
    summary: t.summary ?? null,
    messageCount: messages,
    events: t.events,
    messages: history,
  };
}

export async function myView(ctx: Context, t: Ticket): Promise<MyTicket> {
  return {
    id: t.id,
    number: t.number,
    subject: t.subject,
    status: t.status,
    priority: t.priority,
    label: labelOf(ctx, t.label),
    assignee: t.assignee ? { displayName: t.assignee.displayName } : null,
    source: t.source,
    createdAt: t.createdAt,
    closedAt: t.closedAt ?? null,
    lastActivityAt: (await activity(ctx, t)).last,
    channelUrl: channelUrl(ctx, t),
  };
}

export async function myDetail(ctx: Context, t: Ticket): Promise<MyTicketDetail> {
  return {
    ...(await myView(ctx, t)),
    description: t.description,
    events: t.events.map((e) => ({
      type: e.type,
      at: e.at,
      by: { displayName: e.by.displayName },
      // The close reason is for the staff log; a reply's message id means nothing here.
      ...(e.detail !== undefined && e.type !== "closed" && e.type !== "replied"
        ? { detail: e.detail }
        : {}),
    })),
  };
}

/** The member's tickets: open ones first, then newest first. */
export async function myTickets(ctx: Context, userId: string): Promise<MyTicket[]> {
  const tickets = (await authorTickets(ctx, userId)).sort(
    (a, b) => Number(b.status === "open") - Number(a.status === "open") || b.number - a.number,
  );
  const out: MyTicket[] = [];
  for (const t of tickets) out.push(await myView(ctx, t));
  return out;
}

export interface TicketFilters {
  status?: TicketStatus;
  /** A user id, or null for unassigned tickets. */
  assignee?: string | null;
  priority?: Priority;
  /** A label key, or null for tickets without one. */
  label?: string | null;
}

/** Tickets for the staff, newest first. */
export async function listTickets(ctx: Context, f: TicketFilters): Promise<StaffTicket[]> {
  const out: StaffTicket[] = [];
  for (const t of (await allTickets(ctx)).toReversed()) {
    if (f.status && t.status !== f.status) continue;
    if (f.assignee !== undefined && (t.assignee?.id ?? null) !== f.assignee) continue;
    if (f.priority && t.priority !== f.priority) continue;
    if (f.label !== undefined && t.label !== f.label) continue;
    out.push(await staffView(ctx, t));
  }
  return out;
}
