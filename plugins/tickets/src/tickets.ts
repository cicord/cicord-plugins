import { relay } from "./relay.ts";
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
  revision?: number;
  erasing?: boolean;
  provision?: { topic: string; phase: "queued" | "creating" | "welcome"; since: number };
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
  copies?: { messageId: string; userId: string; origin?: string }[];
  directCopies?: {
    messageId: string;
    authorId: string;
    sourceMessageId?: string;
    origin?: string;
  }[];
  redactedMessageIds?: string[];
  notices?: { messageId: string; users: string[] }[];
  firstResponseAt?: string;
  reminded?: boolean;
  warningAt?: number;
  rating?: number;
  transcriptPages?: number;
  expiresAt?: number;
  logCopy?: { channelId: string; messageId: string };
  withdrawLog?: boolean;
  sourcePolicy?: string;
  archivePolicy?: string;
  archiveRoles?: string[];
  logDelivery?: {
    channelId: string;
    marker: string;
    content: string;
    phase: "pending" | "summary" | "attaching" | "attached";
    messageId?: string;
  };
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

export function person(user: Pick<User, "id" | "displayName">, member?: Member): Person {
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
  return t.status === "open" && t.channelId
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
    // Initial modmail content in early 0.4 records was copied into the opening form.
    // It must never enter a metadata projection, mutation response or renewed channel.
    ...(raw.source === "modmail" ? { description: "" } : {}),
    revision: raw.revision ?? 0,
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

export async function saveTicket(ctx: Context, t: Ticket, privacyWrite = false): Promise<void> {
  const key = ticketKey(t.number);
  const entry = await ctx.kv.getEntry(key);
  const saved = entry?.value as unknown as Ticket | undefined;
  if (saved?.erasing && !privacyWrite)
    throw new TicketConflict("Ticket privacy update in progress");
  const prior = saved ? (saved.revision ?? 0) : -1;
  if (prior !== (t.revision ?? -1))
    throw new TicketConflict("Ticket changed; reload before saving");
  const revision = prior + 1;
  const result = await ctx.kv
    .atomic()
    .check(key, entry?.version)
    .set(key, { ...t, revision } as unknown as Json)
    .commit();
  if (!result.ok) throw new TicketConflict("Ticket changed; reload before saving");
  t.revision = revision;
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
          name: ctx.i18n.t("general"),
          staffRoles: ctx.config.staffRoles,
          category: ctx.config.category,
          logChannel: ctx.config.logChannel,
          defaultLabels: [] as string[],
          fields: undefined,
          retainSourceForTranscript: false,
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
  // Application records belong to their author and the configured staff. Archived
  // channel content has a separate, stronger gate (mayReadTranscript).
  if (t.provision && !t.channelId) return true;
  if (t.channelRemoved ?? t.status === "closed") return true;
  return member.canView({ id: t.channelId });
}

export async function verifyReaders(
  ctx: Context,
  t: Pick<Ticket, "channelId" | "author" | "type">,
  options: { viewer?: string; destination?: string; withoutMember?: string } = {},
) {
  const type = ticketType(ctx, t.type);
  if (!type || !ctx.server.verifyReaders) return undefined;
  try {
    return await ctx.server.verifyReaders(
      { id: t.channelId },
      {
        roles: type.staffRoles.map((key) => ctx.server.role(key).id),
        members: [
          ctx.bot.user.id,
          ...(t.author.id.startsWith("deleted-user-") ? [] : [t.author.id]),
        ],
        ...(options.viewer ? { viewer: options.viewer } : {}),
        ...(options.destination ? { destination: { id: options.destination } } : {}),
        ...(options.withoutMember ? { withoutMember: options.withoutMember } : {}),
      },
    );
  } catch {
    return undefined;
  }
}

export async function mayReadTranscript(ctx: Context, t: Ticket, viewer: Member | undefined) {
  if (!viewer || !t.archivePolicy || t.channelRemoved || !mayRead(ctx, t, viewer, true))
    return false;
  const checked = await verifyReaders(ctx, t, { viewer: viewer.id });
  return (
    !!checked?.known &&
    checked.confined &&
    checked.viewerCanRead &&
    checked.fingerprint === t.archivePolicy
  );
}

export async function relayAllowed(ctx: Context, t: Ticket, actor: Member) {
  const check = await verifyReaders(ctx, t, { viewer: actor.id });
  return (
    !!check?.known &&
    check.confined &&
    check.viewerCanRead &&
    !!t.sourcePolicy &&
    check.fingerprint === t.sourcePolicy
  );
}
/** Check both principals immediately before forwarding rendered text or attachment URLs.
 * Guild membership alone cannot authorize reading a ticket channel's history. */
export async function relayRecipient(ctx: Context, t: Ticket, staffId: string) {
  const [staff, member] = await Promise.all([
    ctx.server.member(staffId),
    ctx.server.member(t.author.id),
  ]);
  if (!staff || !member || !isStaff(ctx, staff, t.type)) return undefined;
  const [sender, recipient] = await Promise.all([
    relayAllowed(ctx, t, staff),
    relayAllowed(ctx, t, member),
  ]);
  return sender && recipient ? member : undefined;
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

function translatedLabel(ctx: Context, key: string) {
  const k = "labels." + key;
  const label = ctx.i18n.t(k);
  return label === k ? key : label;
}

export function labelOf(ctx: Context, key: string | null): Label | null {
  if (key === null) return null;
  const l = ctx.config.labels.find((x) => x.key === key);
  // A label removed from the config stays readable on the tickets that have it.
  return l
    ? { key: l.key, name: l.name ?? translatedLabel(ctx, key), emoji: l.emoji ?? null }
    : { key, name: key, emoji: null };
}

export function isLabel(ctx: Context, key: string): boolean {
  return ctx.config.labels.some((l) => l.key === key);
}

// ───────────────────────────────────────────────────────────── messages

export function panelMessage(ctx: Context): MessagePayload {
  const { title, description, buttonLabel, color } = ctx.config.panel;
  return {
    embeds: [
      {
        title: title ?? ctx.i18n.t("panelTitle"),
        description: description ?? ctx.i18n.t("panelDescription"),
        color,
      },
    ],
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
          : [
              {
                type: "button",
                id: "open",
                label: buttonLabel ?? ctx.i18n.t("panelButton"),
                emoji: "🎫",
                style: "primary",
              },
            ],
      },
    ],
  };
}

export function closeButton(ctx: Context, n: number): MessagePayload["components"] {
  return [
    {
      type: "row",
      components: [
        {
          type: "button",
          id: `close:${n}`,
          label: ctx.i18n.t("close"),
          emoji: "🔒",
          style: "danger",
        },
      ],
    },
    {
      type: "row",
      components: [
        { type: "button", id: `claim:${n}`, label: ctx.i18n.t("claim"), style: "secondary" },
      ],
    },
  ];
}

function ticketEmbed(ctx: Context, t: Ticket): Embed {
  const label = labelOf(ctx, t.label);
  return {
    title: `#${t.number} — ${t.subject}`,
    description: t.description || ctx.i18n.t("noDetails"),
    color: ctx.config.panel.color,
    ...(label
      ? {
          fields: [
            {
              name: ctx.i18n.t("label"),
              value: `${label.emoji ? `${label.emoji} ` : ""}${label.name}`,
            },
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
  if (!t.channelId || (t.channelRemoved ?? t.status === "closed")) return undefined;
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
  t: Pick<Ticket, "number" | "subject" | "author" | "type" | "provision">,
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
    topic:
      t.provision?.topic ??
      ctx.i18n.t("channelTopic", {
        number: t.number,
        subject: t.subject,
        member: t.author.displayName,
      }),
    overwrites,
  });
}

export class OpenLimit extends Error {}
export class TicketConflict extends Error {}
/** Reserve against the shared durable member index across all invocation VMs. */
async function reserve(ctx: Context, userId: string, number: number) {
  const key = "admission:" + userId;
  for (;;) {
    const entry = await ctx.kv.getEntry(key);
    if ((await openTickets(ctx, userId)).length >= ctx.config.maxOpenPerMember)
      throw new OpenLimit(ctx.i18n.t("openLimit"));
    const claim = await ctx.kv
      .atomic()
      .check(key, entry?.version)
      .set(key, number, { ttlSeconds: 120 })
      .set(openKey(userId, number), true, { ttlSeconds: 120 })
      .commit();
    if (claim.ok) return;
  }
}

type OpenInput = {
  user: Pick<User, "id" | "displayName" | "mention">;
  member: Member | undefined;
  subject: string;
  description: string;
  label: string | null;
  source: TicketSource;
  type?: string;
  appeal?: Ticket["appeal"];
  request?: Ticket["request"];
};

async function allocate(ctx: Context, input: OpenInput): Promise<Ticket> {
  const type = ticketType(ctx, input.type);
  if (!type) throw new Error("Unknown ticket type");
  const author = person(input.user, input.member);
  const number = await ctx.kv.increment("seq");
  await reserve(ctx, author.id, number);
  const now = new Date().toISOString();
  const ticket: Ticket = {
    id: String(number),
    number,
    subject: input.subject,
    description: input.description,
    status: "open",
    author,
    channelId: "",
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
  return ticket;
}

async function storeOpen(ctx: Context, t: Ticket) {
  await saveTicket(ctx, t);
  await ctx.kv.set(openKey(t.author.id, t.number), true);
  await ctx.kv.set(authorKey(t.author.id, t.number), true);
  await ctx.kv.increment("stats:opened");
  if (t.channelId) await ctx.kv.set(channelKey(t.channelId), t.number);
}

/** Interop actions commit this request with their idempotency result. Discord effects
 * start in a separate invocation that can read the authoritative committed record. */
export async function requestTicket(ctx: Context, input: OpenInput) {
  const t = await allocate(ctx, input);
  t.provision = {
    topic:
      "Cicord · " + ctx.bot.key + "/" + ctx.plugin.instance + "/" + t.number + "/" + t.createdAt,
    phase: "queued",
    since: 0,
  };
  await storeOpen(ctx, t);
  await ctx.schedule.after(1000, "provision", { number: t.number });
  return { id: t.id };
}

export async function provisionTicket(ctx: Context, t: Ticket) {
  const job = t.provision;
  if (!job || t.status !== "open") return;
  if (!t.channelId) {
    if (job.phase === "creating" && Date.now() - job.since < 120000) return;
    job.phase = "creating";
    job.since = Date.now();
    await saveTicket(ctx, t);
    const receipt = await ctx.server.recoverOwnedChannel(job.topic);
    if (receipt.status === "conflict")
      throw new Error("Conflicting channel ownership; provisioning paused");
    const channel =
      receipt.status === "owned" && receipt.id
        ? ctx.server.channel({ id: receipt.id })
        : await createTicketChannel(ctx, t);
    t.channelId = channel.id;
    job.phase = "welcome";
    await saveTicket(ctx, t);
  }
  const channel = ctx.server.channel({ id: t.channelId });
  const check = await verifyReaders(ctx, t);
  if (!check?.known || !check.confined)
    throw new Error("Cannot verify the provisioned ticket audience");
  await ctx.kv.set(channelKey(channel.id), t.number);
  if (!t.welcomeId) {
    let before: string | undefined;
    for (;;) {
      const rows = await channel.messages({ limit: 100, ...(before ? { before } : {}) });
      const previous = rows.find(
        (m) =>
          m.author.id === ctx.bot.user.id && m.embeds.some((e) => e.footer?.text === job.topic),
      );
      if (previous) {
        t.welcomeId = previous.id;
        await saveTicket(ctx, t);
        break;
      }
      if (rows.length < 100) break;
      const next = rows[rows.length - 1]!.id;
      if (next === before) throw new Error("Welcome history cursor did not advance");
      before = next;
    }
  }
  if (!t.welcomeId) await welcomeTicket(ctx, t, channel);
  await publish(ctx, t, "opened");
  delete t.provision;
  await saveTicket(ctx, t);
}

export async function openTicket(
  ctx: Context,
  input: OpenInput,
): Promise<{ ticket: Ticket; channel: TextChannel }> {
  const ticket = await allocate(ctx, input);
  const { number, author } = ticket;
  let channel: TextChannel;
  try {
    channel = await createTicketChannel(ctx, ticket);
  } catch (error) {
    await ctx.kv.delete(openKey(author.id, number));
    throw error;
  }
  ticket.channelId = channel.id;
  if (ticket.source === "modmail") {
    const check = await verifyReaders(ctx, ticket, { viewer: author.id });
    if (!check?.known || !check.confined || !check.viewerCanRead) {
      await ctx.kv.delete(openKey(author.id, number));
      try {
        await ctx.server.deleteChannel(channel, "Private ticket audience could not be verified");
      } catch {}
      await input.member?.send(ctx.i18n.t("relayDenied"));
      throw new Error("Private ticket audience unavailable");
    }
    ticket.sourcePolicy = check.fingerprint;
  }
  await storeOpen(ctx, ticket);
  await welcomeTicket(ctx, ticket, channel, input.member);
  await publish(ctx, ticket, "opened");
  return { ticket, channel };
}

async function welcomeTicket(ctx: Context, ticket: Ticket, channel: TextChannel, member?: Member) {
  const number = ticket.number;
  const type = ticketType(ctx, ticket.type);
  if (!type) throw new Error("Unknown ticket type");
  let staff =
    type.staffRoles.map((r) => ctx.server.role(r).mention).join(" ") || ctx.i18n.t("team");
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
  if (ticket.source === "modmail" && (!member || !(await relayAllowed(ctx, ticket, member)))) {
    await member?.send(ctx.i18n.t("relayDenied"));
    return;
  }
  const welcome = await channel.send({
    content: render(ctx.config.welcomeMessage ?? ctx.i18n.t("welcome"), {
      member: "<@" + ticket.author.id + ">",
      staff,
      subject: ticket.subject,
      number: String(number),
    }),
    embeds: [
      {
        ...ticketEmbed(ctx, ticket),
        ...(ticket.provision ? { footer: { text: ticket.provision.topic } } : {}),
      },
    ],
    components: closeButton(ctx, number),
    allowedMentions: {
      users: [ticket.author.id, ...mentions],
      roles: type.staffRoles.map((r) => ctx.server.role(r).id),
      everyone: false,
    },
  });
  ticket.welcomeId = welcome.id;
  await saveTicket(ctx, ticket);
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
  const config = ticketType(ctx, ticket.type);
  const check = await verifyReaders(ctx, ticket);
  if (config?.retainSourceForTranscript && check?.known && check.confined) {
    await ctx.server.editChannel(
      { id: ticket.channelId },
      {
        overwrites: Object.fromEntries(
          ["@everyone", "member:" + ticket.author.id, ...config.staffRoles].map((k) => [
            k,
            {
              deny: [
                "SendMessages",
                "SendMessagesInThreads",
                "CreatePublicThreads",
                "CreatePrivateThreads",
              ],
            },
          ]),
        ),
      },
    );
    ticket.archivePolicy = check.fingerprint;
    ticket.archiveRoles = [...config.staffRoles].sort();
  }
  const closed: Ticket = {
    ...ticket,
    pendingClose: true,
    channelRemoved: false,
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
  if (!closed.channelRemoved && !closed.archivePolicy) {
    try {
      await ctx.server.deleteChannel(
        { id: closed.channelId },
        ctx.i18n.t("closeReason", { number: closed.number }),
      );
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
        content: ctx.i18n.t("rate", { number: closed.number }),
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
  const channel =
    (!ticket.archivePolicy && (await liveChannel(ctx, ticket))) ||
    (await createTicketChannel(ctx, ticket));
  const reopened: Ticket = { ...ticket, status: "open", channelId: channel.id };
  await purgeArchive(ctx, ticket);
  delete reopened.logDelivery;
  delete reopened.archivePolicy;
  delete reopened.archiveRoles;
  delete reopened.transcriptPages;
  delete reopened.expiresAt;
  delete reopened.logCopy;
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
    content: ctx.i18n.t("reopened", {
      member: "<@" + ticket.author.id + ">",
      staff: escapeMarkdown(by.displayName),
    }),
    embeds: [ticketEmbed(ctx, reopened)],
    components: closeButton(ctx, ticket.number),
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
  _channel: TextChannel,
  by: Person,
  content: string,
): Promise<string | undefined> {
  const seq = await ctx.kv.increment("portal:relaySeq");
  return relay(ctx, ticket, "portal", by, content, "portal-" + seq, new Date());
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
    channelId: t.status === "open" ? t.channelId || null : null,
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
    if (channel && t.status === "open") {
      // Portal replies are posted by the bot: the timeline says who wrote each one.
      const repliedBy = new Map<string, Person>();
      for (const e of t.events ?? []) {
        if (e.type === "replied" && e.detail) repliedBy.set(e.detail, e.by);
      }
      const raw = await channel.messages({ limit: 50 });
      const safe = redactLive(t, raw);
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
export function redactLive<T extends { id: string }>(t: Ticket, rows: T[]): T[] {
  const hidden = new Set(t.redactedMessageIds ?? []);
  return rows.filter((row) => !hidden.has(row.id));
}
