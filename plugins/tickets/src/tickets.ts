/**
 * Ticket records and the operations shared by the Discord handlers and the portal routes
 * (open, close, reopen, reply…). The portal shapes are declared in routes.ts.
 *
 * Closed transcripts have a configured retention period.
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

import { archive, postArchive, purgeArchive } from "./transcript.ts";
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
  type: string;
  request?: { caller: string; key: string };
  appeal?: { number: number; bot: string; instance: string; status?: string };
  closedAudience?: { known: boolean; roles: string[]; members: string[]; denied: string[] };
  labels: string[];
  notes: { by: Person; at: string; content: string }[];
  copies?: { messageId: string; userId: string }[];
  directCopies?: { messageId: string; authorId: string; sourceMessageId?: string }[];
  redacted?: string[];
  notices?: { messageId: string; users: string[] }[];
  firstResponseAt?: string;
  reminded?: boolean;
  warningAt?: number;
  rating?: number;
  transcriptPages?: number;
  expiresAt?: number;
  logCopy?: { channelId: string; messageId: string };
  withdrawLog?: boolean;
  pendingClose?: boolean;
  summaryPosted?: boolean;
  welcomeId?: string;
  closeReason?: string;
  /** The channel was deleted when the ticket was closed. */
  channelRemoved?: boolean;
}

// Zero-padded numbers keep `kv.list()` (lexicographic) in ticket order.
const pad = (n: number): string => String(n).padStart(8, "0");
export const ticketKey = (n: number): string => `ticket:${pad(n)}`;
export const openKey = (userId: string, n: number): string => `open:${userId}:${n}`;
export const channelKey = (channelId: string): string => `channel:${channelId}`;
export const activityKey = (n: number): string => `activity:${n}`;
export const lastActivityKey = (n: number): string => `last:${n}`;
/** Index of a member's tickets (`GET /tickets/mine`). */
export const authorKey = (userId: string, n: number): string => `author:${userId}:${pad(n)}`;
/** Set once the author index covers the tickets written before 0.2. */
const AUTHOR_INDEX = "index:authors";

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
    source: raw.source ?? "discord",
    type: raw.type ?? "default",
    labels: raw.labels ?? (raw.label ? [raw.label] : []),
    notes: raw.notes ?? [],
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

export async function allTickets(ctx: Context): Promise<Ticket[]> {
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

export function types(ctx: Context) {
  return ctx.config.types?.length
    ? ctx.config.types
    : [
        {
          key: "default",
          name: "General",
          staffRoles: ctx.config.staffRoles,
          category: ctx.config.category,
          logChannel: ctx.config.logChannel,
          defaultLabels: [] as string[],
          fields: undefined,
        },
      ];
}

export function ticketType(ctx: Context, key?: string) {
  const configured = types(ctx);
  return key ? configured.find((t) => t.key === key) : configured[0];
}

export function isStaff(ctx: Context, member: Member | undefined, key?: string): boolean {
  if (!member) return false;
  if (!ctx.config.types?.length && (member.access === "admin" || member.id === ctx.server.ownerId))
    return true;
  return types(ctx).some(
    (t) => (!key || t.key === key) && t.staffRoles.some((role) => member.hasRole(role)),
  );
}

/** Type membership is checked for every read, including closed tickets with a deleted channel. */
export function mayRead(ctx: Context, t: Ticket, member?: Member, allowOwner = false): boolean {
  if (!member || !((allowOwner && member.id === t.author.id) || isStaff(ctx, member, t.type)))
    return false;
  if (t.channelRemoved ?? t.status === "closed") {
    const a = t.closedAudience;
    if (!a) return true; // Old records have no captured policy and no transcript.
    if (!a.known || a.denied.includes(member.id)) return false;
    return (
      a.members.includes(member.id) ||
      member.roles.some((role) => a.roles.includes(role.id)) ||
      member.id === ctx.server.ownerId
    );
  }
  return member.canView({ id: t.channelId });
}

/** At most this many holders of each staff role are listed by `GET /staff`. */
const MAX_STAFF_PER_ROLE = 1000;

/**
 * Who can be assigned (`GET /staff`), by display name: the holders of the staff roles (bots
 * excluded), the server owner, and `viewer` (a Cicord admin without a staff role can assign
 * themselves). Other Cicord admins cannot be listed (spec.access is not visible to plugins).
 */
export async function listStaff(
  ctx: Context,
  viewer?: Person | null,
  type?: string,
): Promise<Person[]> {
  const byId = new Map<string, Person>();
  for (const key of new Set(
    types(ctx)
      .filter((t) => (!type || t.key === type) && (!ctx.config.types?.length || !!viewer))
      .flatMap((t) => t.staffRoles),
  )) {
    for (const m of await ctx.server.role(key).members({ limit: MAX_STAFF_PER_ROLE }))
      if (!m.user.bot) byId.set(m.id, person(m.user, m));
  }
  const ownerId = ctx.server.ownerId;
  if (!ctx.config.types?.length && ownerId !== undefined && !byId.has(ownerId)) {
    const owner = await ctx.server.member(ownerId);
    if (owner) byId.set(owner.id, person(owner.user, owner));
  }
  if (viewer && !byId.has(viewer.id)) byId.set(viewer.id, viewer);
  return [...byId.values()].toSorted((a, b) => a.displayName.localeCompare(b.displayName));
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
        components: ctx.config.types?.length
          ? types(ctx).map((t) => ({
              type: "button",
              id: "open:" + t.key,
              label: t.name,
              style: "primary",
            }))
          : [{ type: "button", id: "open", label: buttonLabel, emoji: "🎫", style: "primary" }],
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
    {
      type: "row",
      components: [{ type: "button", id: `claim:${n}`, label: "Claim ticket", style: "secondary" }],
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

/**
 * A handle on the ticket channel, undefined when it is known to be gone. A closed ticket
 * without `channelRemoved` was closed by 0.1, which deleted the channel. The runtime may hand
 * out a handle for a deleted channel it saw earlier: use `liveChannel` before relying on it.
 */
export function ticketChannel(ctx: Context, t: Ticket): TextChannel | undefined {
  if (t.channelRemoved ?? t.status === "closed") return undefined;
  try {
    return ctx.server.channel({ id: t.channelId });
  } catch {
    return undefined;
  }
}

/** The ticket channel when it still exists on Discord (checked with a read). */
export async function liveChannel(ctx: Context, t: Ticket): Promise<TextChannel | undefined> {
  const channel = ticketChannel(ctx, t);
  if (!channel) return undefined;
  try {
    await channel.messages({ limit: 1 });
    return channel;
  } catch {
    return undefined;
  }
}

/** Posts a short notice in an open ticket's channel; a failure is logged, not thrown. */
export async function notice(
  ctx: Context,
  t: Ticket,
  content: string,
  users: string[] = [],
): Promise<void> {
  if (t.status !== "open") return;
  try {
    const channel = ticketChannel(ctx, t);
    if (channel) {
      const sent = await channel.send({ content, allowedMentions: NO_MENTIONS });
      t.notices = [...(t.notices ?? []), { messageId: sent.id, users }];
      await saveTicket(ctx, t);
    }
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
  t: Pick<Ticket, "number" | "subject" | "author" | "type">,
): Promise<TextChannel> {
  // Keys: "@everyone", a role key, "role:<id>" or "member:<id>".
  const overwrites: Record<string, { allow?: Permission[]; deny?: Permission[] }> = {
    "@everyone": { deny: ["ViewChannel"] },
    [`member:${t.author.id}`]: { allow: [...TICKET_PERMS] },
    // The bot keeps access even without Administrator.
    [`member:${ctx.bot.user.id}`]: { allow: [...TICKET_PERMS, "ManageChannels"] },
  };
  const type = ticketType(ctx, t.type);
  if (!type) throw new Error("Ticket type is unavailable");
  for (const role of type.staffRoles) overwrites[role] = { allow: [...TICKET_PERMS] };
  return ctx.server.createChannel({
    name: channelName(ctx.config.channelName, t.number, t.author.displayName),
    ...(type.category ? { category: type.category } : {}),
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
    type?: string;
    appeal?: Ticket["appeal"];
    request?: Ticket["request"];
  },
): Promise<{ ticket: Ticket; channel: TextChannel }> {
  const type = ticketType(ctx, input.type);
  if (!type) throw new Error("Unknown ticket type");
  const author = person(input.user, input.member);
  const number = await ctx.kv.increment("seq");
  const channel = await createTicketChannel(ctx, {
    number,
    subject: input.subject,
    author,
    type: type.key,
  });
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
    label: input.label ?? type.defaultLabels?.[0] ?? null,
    ...(input.request ? { request: input.request } : {}),
    ...(input.appeal ? { appeal: input.appeal } : {}),
    type: type.key,
    labels: [...new Set([...(type.defaultLabels ?? []), ...(input.label ? [input.label] : [])])],
    notes: [],
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

  let staff = type.staffRoles.map((r) => ctx.server.role(r).mention).join(" ") || "The team";
  let mentions: string[] = [];
  if (ctx.features?.enabled("onDuty")) {
    try {
      const result = (await ctx.plugins.query("staff-shifts", "onDuty", {})) as {
        userIds: string[];
      };
      for (const id of result.userIds)
        if (isStaff(ctx, await ctx.server.member(id), ticket.type)) mentions.push(id);
      if (mentions.length) staff = mentions.map((id) => `<@${id}>`).join(" ");
    } catch {
      ctx.log.warn("On-duty staff unavailable");
    }
  }
  const welcome = await channel.send({
    content: render(ctx.config.welcomeMessage, {
      member: input.user.mention,
      staff,
      subject: input.subject,
      number: String(number),
    }),
    embeds: [ticketEmbed(ctx, ticket)],
    components: closeButton(number),
    allowedMentions: {
      users: [input.user.id, ...mentions],
      roles: type.staffRoles.map((r) => ctx.server.role(r).id),
      everyone: false,
    },
  });
  ticket.welcomeId = welcome.id;
  await saveTicket(ctx, ticket);
  await publish(ctx, ticket, "opened");
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
  if (ticket.status === "closed") return ticket;
  await purgeArchive(ctx, ticket);
  const { participants, messages } = await archive(ctx, ticket);
  const audience = ctx.server.audience({ id: ticket.channelId });
  const closed: Ticket = {
    ...ticket,
    pendingClose: true,
    channelRemoved: false,
    closedAudience: {
      known: audience.known,
      roles: [...audience.allowRoles],
      members: [...audience.allowMembers],
      denied: [...audience.denyMembers],
    },
    status: "closed",
    closedAt: new Date().toISOString(),
    closedBy: by,
    summary: { messages, participants: [...participants.values()] },
  };
  delete closed.closeReason;
  if (reason) closed.closeReason = reason;
  addEvent(closed, "closed", by, reason, closed.closedAt);
  await saveTicket(ctx, closed);
  await ctx.kv.increment("stats:closed");
  await finishClose(ctx, closed);
  return closed;
}

/** Resume external effects after the completed archive and close intent were saved. */
export async function finishClose(ctx: Context, closed: Ticket) {
  if (!closed.pendingClose) return;
  await ctx.kv.delete(openKey(closed.author.id, closed.number));
  await ctx.kv.delete(channelKey(closed.channelId));
  await ctx.kv.delete(activityKey(closed.number));
  if (!closed.summaryPosted) {
    await postArchive(ctx, closed);
    closed.summaryPosted = true;
    await saveTicket(ctx, closed);
  }
  if (!closed.channelRemoved) {
    try {
      await ctx.server.deleteChannel({ id: closed.channelId }, `ticket #${closed.number} closed`);
      closed.channelRemoved = true;
    } catch (error) {
      ctx.log.warn("tickets: could not delete the ticket channel", {
        ticket: closed.number,
        error: String(error),
      });
    }
  }
  await publish(ctx, closed, "closed");
  delete closed.pendingClose;
  await saveTicket(ctx, closed);
  try {
    const member = await ctx.server.member(closed.author.id);
    if (member)
      await member.send({
        content: `Rate ticket #${closed.number} (1–5).`,
        components: [
          {
            type: "row",
            components: [1, 2, 3, 4, 5].map((score) => ({
              type: "button",
              id: `rate:${closed.number}:${score}`,
              label: String(score),
              style: "secondary",
            })),
          },
        ],
      });
  } catch {
    ctx.log.info("Rating DM unavailable", { ticket: closed.number });
  }
  ctx.log.info("ticket closed", {
    ticket: closed.number,
    by: closed.closedBy?.id ?? "",
    messages: closed.summary?.messages ?? 0,
  });
}

/**
 * Reopens a closed ticket, in a new channel (same permissions) when the old one is gone. The
 * channel and its message come first: a failure leaves the ticket closed.
 */
export async function reopenTicket(ctx: Context, ticket: Ticket, by: Person): Promise<Ticket> {
  if (ticket.pendingClose) await finishClose(ctx, ticket);
  const channel = (await liveChannel(ctx, ticket)) ?? (await createTicketChannel(ctx, ticket));
  const reopened: Ticket = { ...ticket, status: "open", channelId: channel.id };
  await purgeArchive(ctx, reopened);
  reopened.reminded = false;
  delete reopened.firstResponseAt;
  delete reopened.warningAt;
  delete reopened.rating;
  delete reopened.summaryPosted;
  delete reopened.closedAudience;
  delete reopened.closedAt;
  delete reopened.closedBy;
  delete reopened.closeReason;
  delete reopened.summary;
  delete reopened.channelRemoved;
  const welcome = await channel.send({
    content: `<@${ticket.author.id}> Reopened by **${escapeMarkdown(by.displayName)}**.`,
    embeds: [ticketEmbed(ctx, reopened)],
    components: closeButton(ticket.number),
    allowedMentions: { users: [ticket.author.id], roles: false, everyone: false },
  });

  reopened.welcomeId = welcome.id;
  reopened.notices = [{ messageId: welcome.id, users: [ticket.author.id, by.id] }];
  addEvent(reopened, "reopened", by);
  await saveTicket(ctx, reopened);
  await ctx.kv.set(openKey(ticket.author.id, ticket.number), true);
  await ctx.kv.set(channelKey(channel.id), ticket.number);
  await ctx.kv.set(lastActivityKey(ticket.number), new Date().toISOString());
  // Keep counting from the messages of the first round.
  await ctx.kv.set(activityKey(ticket.number), ticket.summary?.messages ?? 0);
  ctx.log.info("ticket reopened", { ticket: ticket.number, by: by.id, channel: channel.id });
  return reopened;
}

/** Posts a staff message from the portal in the ticket channel. Returns its id. */
export async function postReply(
  ctx: Context,
  ticket: Ticket,
  channel: TextChannel,
  by: Person,
  content: string,
): Promise<string> {
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
  if (ticket.source === "modmail") {
    const member = await ctx.server.member(ticket.author.id);
    if (member) {
      const dm = await member.send(
        { content, allowedMentions: NO_MENTIONS },
        { retractable: true },
      );
      ticket.directCopies = [...(ticket.directCopies ?? []), { messageId: dm.id, authorId: by.id }];
    }
  }
  ticket.copies = [...(ticket.copies ?? []), { userId: by.id, messageId: message.id }];
  ticket.firstResponseAt ??= message.createdAt.toISOString();
  delete ticket.warningAt;
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
    type: t.type,
    labels: t.labels,
    rating: t.rating ?? null,
  };
}

/** Everything about a ticket, with its channel's last 50 messages read from Discord. */
export async function staffDetail(ctx: Context, t: Ticket): Promise<StaffTicketDetail> {
  const { messages, channelId: _current, ...view } = await staffView(ctx, t);
  let history: TicketMessage[] | null = null;
  try {
    const channel = ticketChannel(ctx, t);
    if (channel) {
      // Portal replies are posted by the bot: the timeline says who wrote each one.
      const repliedBy = new Map<string, Person>();
      for (const e of t.events ?? []) {
        if (e.type === "replied" && e.detail) repliedBy.set(e.detail, e.by);
      }
      const raw = await channel.messages({ limit: 50 });
      const safe = await redactLive(ctx, t, raw);
      history = safe.toReversed().map((m) => ({
        id: m.id,
        author: { ...person(m.author, m.member), bot: m.author.bot },
        content: m.content,
        embeds: (m.embeds ?? []).map((e) => ({
          title: e.title ?? null,
          description: e.description ?? null,
        })),
        repliedBy: repliedBy.get(m.id) ?? null,
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
    appeal: t.appeal ? { number: t.appeal.number, status: t.appeal.status ?? null } : null,
    notes: t.notes,
    firstResponseAt: t.firstResponseAt ?? null,
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
    type: t.type,
    labels: t.labels,
    rating: t.rating ?? null,
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
export async function myTickets(ctx: Context, member: Member): Promise<MyTicket[]> {
  const tickets = (await authorTickets(ctx, member.id))
    .filter((t) => mayRead(ctx, t, member, true))
    .toSorted(
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
export async function listTickets(
  ctx: Context,
  f: TicketFilters,
  member?: Member,
): Promise<StaffTicket[]> {
  const out: StaffTicket[] = [];
  for (const t of (await allTickets(ctx)).toReversed()) {
    if (!mayRead(ctx, t, member)) continue;
    if (f.status && t.status !== f.status) continue;
    if (f.assignee !== undefined && (t.assignee?.id ?? null) !== f.assignee) continue;
    if (f.priority && t.priority !== f.priority) continue;
    if (
      f.label !== undefined &&
      (f.label === null ? t.labels.length > 0 : !t.labels.includes(f.label))
    )
      continue;
    out.push(await staffView(ctx, t));
  }
  return out;
}

export async function publish(ctx: Context, t: Ticket, topic: "opened" | "closed" | "rated") {
  await ctx.events.publish(
    topic,
    {
      id: t.id,
      memberId: t.author.id,
      type: t.type,
      labels: t.labels,
      ...(t.assignee ? { assignee: t.assignee.id } : {}),
      ...(t.closedAt
        ? {
            durationMinutes: Math.max(
              0,
              Math.round((Date.parse(t.closedAt) - Date.parse(t.createdAt)) / 60000),
            ),
          }
        : {}),
      ...(t.rating ? { rating: t.rating } : {}),
    },
    { idempotencyKey: `ticket:${t.id}:${topic}:${t.closedAt ?? t.createdAt}` },
  );
}

/** A source message written by a member can survive erasure on Discord. Do not import
 * it again into the portal or an archive when the channel eventually closes. */
export async function redactLive<T extends { author: { id: string } }>(
  ctx: Context,
  t: Ticket,
  rows: T[],
): Promise<T[]> {
  if (!t.redacted?.length) return rows;
  const hidden = new Set<string>();
  for (const id of new Set(rows.map((r) => r.author.id))) {
    if (t.redacted.includes(await ctx.privacy.pseudonym(id))) hidden.add(id);
  }
  return rows.filter((row) => !hidden.has(row.author.id));
}
