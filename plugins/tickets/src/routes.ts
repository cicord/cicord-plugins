/**
 * Portal contract of the tickets routes (plugin.yaml spec.routes.types). Type-only and
 * self-contained (no imports): `cicord portal typegen` copies it into the portals, which get a
 * typed client for these routes. The handlers are checked against it (`defineRoutes`).
 *
 * Errors are `ApiError` bodies: 400 `invalid` (bad query or body), 403 `forbidden` (not
 * staff), 404 `not_found` (no such ticket, or not the viewer's), 409 `limit` (too many open
 * tickets), `closed` (the ticket is closed) or `open` (reopening an open ticket).
 */

export type TicketStatus = "open" | "closed";
export type Priority = "low" | "normal" | "high" | "urgent";
/** Where the ticket was opened: the Discord panel or a portal. */
export type TicketSource = "discord" | "portal";

/** A Discord user as the server shows them. */
export interface Person {
  id: string;
  displayName: string;
}

/** A configured label (config `labels`). */
export interface Label {
  key: string;
  name: string;
  emoji: string | null;
}

export type TicketEventType =
  | "opened"
  | "assigned"
  | "unassigned"
  | "priority"
  | "label"
  | "closed"
  | "reopened"
  | "replied";

/**
 * One entry of a ticket's timeline (the last 100 are kept). `detail`: the source for
 * `opened`, the assignee's name for `assigned`, the new priority for `priority`, the new label
 * key (or `none`) for `label`, the reason for `closed`, the message id for `replied`.
 */
export interface TicketEvent {
  type: TicketEventType;
  at: string;
  by: Person;
  detail?: string;
}

/** A timeline entry as the member sees it: names only, no close reason (staff-only). */
export interface MyTicketEvent {
  type: TicketEventType;
  at: string;
  by: { displayName: string };
  detail?: string;
}

/** One of the viewer's own tickets. */
export interface MyTicket {
  id: string;
  number: number;
  subject: string;
  status: TicketStatus;
  priority: Priority;
  label: Label | null;
  /** Name only. */
  assignee: { displayName: string } | null;
  source: TicketSource;
  createdAt: string;
  closedAt: string | null;
  lastActivityAt: string | null;
  /** https://discord.com/channels/<server>/<channel> while the ticket is open. */
  channelUrl: string | null;
}

export interface MyTicketDetail extends MyTicket {
  description: string;
  events: MyTicketEvent[];
}

/** One item of `GET /tickets` (the 0.1 fields, then the 0.2 ones). */
export interface StaffTicket {
  id: string;
  subject: string;
  status: TicketStatus;
  author: Person;
  createdAt: string;
  closedAt: string | null;
  /** The ticket channel while the ticket is open. */
  channelId: string | null;
  /** Messages written in the ticket (members and staff, not bots). */
  messages: number;
  lastActivityAt: string | null;
  number: number;
  priority: Priority;
  label: Label | null;
  assignee: Person | null;
  source: TicketSource;
}

/** The text of an embed of a ticket message (bot messages: replies, notices). */
export interface TicketEmbed {
  title: string | null;
  description: string | null;
}

/** A message of the ticket channel, read from Discord at request time (never stored). */
export interface TicketMessage {
  id: string;
  author: Person & { bot: boolean };
  content: string;
  /** The text of its embeds (a portal reply is an embed posted by the bot). */
  embeds: TicketEmbed[];
  /** For a reply sent from the portal: the staff member who wrote it (the author is the bot). */
  repliedBy: Person | null;
  createdAt: string;
}

export interface StaffTicketDetail extends Omit<StaffTicket, "messages" | "channelId"> {
  description: string;
  /** Last channel of the ticket, also once closed (0.1 field). */
  channelId: string;
  /** https://discord.com/channels/<server>/<channel> while the ticket is open. */
  channelUrl: string | null;
  closedBy: Person | null;
  closeReason: string | null;
  /** Filled when the ticket is closed. */
  summary: { messages: number; participants: Person[] } | null;
  /** What `StaffTicket.messages` counts. */
  messageCount: number;
  events: TicketEvent[];
  /**
   * The last 50 messages of the ticket channel, oldest first; null when the channel is gone
   * (closed ticket) or cannot be read.
   */
  messages: TicketMessage[] | null;
}

export interface ApiError {
  error: { code: string; message: string };
}

export interface Routes {
  // ── members (their own tickets only)

  /** The viewer's tickets: open ones first, newest first. */
  "GET /tickets/mine": { response: { items: MyTicket[] } };
  /** One of the viewer's tickets; 404 for anyone else's. */
  "GET /tickets/mine/:id": { response: MyTicketDetail };
  /**
   * Opens a ticket like the Discord panel does (private channel, welcome message). Answers
   * 201. 409 `limit` when the member already has `maxOpenPerMember` open tickets.
   */
  "POST /tickets": {
    body: { subject: string; description: string; label?: string | null };
    response: MyTicket;
  };

  // ── staff (a staff role, the server owner or a Cicord admin)

  /** Tickets, newest first. `assignee`: a user id, `me` or `none`; `label`: a key or `none`. */
  "GET /tickets": {
    query: { status?: TicketStatus; assignee?: string; priority?: Priority; label?: string };
    response: { items: StaffTicket[] };
  };
  "GET /tickets/:id": { response: StaffTicketDetail };
  /**
   * Who can be assigned, by display name: the holders of the staff roles (bots excluded),
   * the server owner and the viewer.
   */
  "GET /staff": { response: { items: Person[] } };
  /** `userId`: a staff member's id, `me`, or null to unassign. */
  "POST /tickets/:id/assign": { body: { userId: string | null }; response: StaffTicket };
  "PATCH /tickets/:id": {
    body: { priority?: Priority; label?: string | null };
    response: StaffTicket;
  };
  /** Same as the Close button; the reason goes to the staff log. 409 `closed`. */
  "POST /tickets/:id/close": { body: { reason?: string }; response: StaffTicket };
  /** Recreates the channel when it was removed on close. 409 `open`. */
  "POST /tickets/:id/reopen": { response: StaffTicket };
  /** Posts in the ticket channel, signed with the viewer's name. Answers 201. 409 `closed`. */
  "POST /tickets/:id/messages": { body: { content: string }; response: { id: string } };
}
