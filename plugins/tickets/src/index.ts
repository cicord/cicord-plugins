import {
  command,
  definePlugin,
  defineRoutes,
  type ComponentInteraction,
  type Context,
  type Member,
  type RouteEnvelope,
  type User,
} from "@cicord/sdk";
import type { Person, Priority, Routes } from "./routes.ts";
import {
  PRIORITIES,
  activityKey,
  addEvent,
  channelKey,
  closeTicket,
  escapeMarkdown,
  getTicket,
  isLabel,
  isStaff,
  lastActivityKey,
  listStaff,
  listTickets,
  liveChannel,
  myDetail,
  myTickets,
  myView,
  notice,
  numberOf,
  openTicket,
  openTickets,
  panelMessage,
  person,
  postReply,
  reopenTicket,
  saveTicket,
  staffDetail,
  staffView,
  type Ticket,
  type TicketFilters,
} from "./tickets.ts";

/** The opener and the staff may close a ticket. */
async function closable(
  ctx: Context,
  interaction: ComponentInteraction,
): Promise<Ticket | undefined> {
  const n = numberOf(interaction.componentId);
  const ticket = n === undefined ? undefined : await getTicket(ctx, n);
  if (!ticket || ticket.status !== "open") {
    await interaction.reply({ content: "This ticket is already closed.", ephemeral: true });
    return undefined;
  }
  if (ticket.author.id !== interaction.user.id && !isStaff(ctx, interaction.member)) {
    await interaction.reply({
      content: "Only the member who opened this ticket or the staff can close it.",
      ephemeral: true,
    });
    return undefined;
  }
  return ticket;
}

// ───────────────────────────────────────────────────────────── route helpers

type Viewer = { readonly user: User; readonly member?: Member } | undefined;

function fail(status: number, code: string, message: string): RouteEnvelope {
  return { status, body: { error: { code, message } } };
}

function failed(x: unknown): x is RouteEnvelope {
  return typeof x === "object" && x !== null && "status" in x && typeof x.status === "number";
}

/** The viewer when they are staff (actions are attributed to them), else 403. */
function staffViewer(ctx: Context, viewer: Viewer): Person | RouteEnvelope {
  if (!viewer?.member || !isStaff(ctx, viewer.member))
    return fail(403, "forbidden", "only the ticket staff can do this");
  return person(viewer.user, viewer.member);
}

/**
 * Read-only staff routes: a viewer must be staff; a call without a viewer is the runtime's
 * own token (admin, checked by the runtime), accepted as in 0.1.
 */
function staffReader(ctx: Context, viewer: Viewer): Person | null | RouteEnvelope {
  return viewer ? staffViewer(ctx, viewer) : null;
}

function memberViewer(viewer: Viewer): { user: User; member: Member } | RouteEnvelope {
  if (!viewer?.member) return fail(403, "forbidden", "members only");
  return { user: viewer.user, member: viewer.member };
}

async function ticketById(ctx: Context, id: string): Promise<Ticket | RouteEnvelope> {
  const ticket = /^[1-9]\d{0,9}$/.test(id) ? await getTicket(ctx, Number(id)) : undefined;
  return ticket ?? fail(404, "not_found", "no such ticket");
}

/** A JSON object with only `allowed` keys (no body counts as `{}` when `optional`). */
function objectBody(
  body: unknown,
  allowed: readonly string[],
  optional = false,
): Record<string, unknown> | RouteEnvelope {
  if (body === undefined && optional) return {};
  if (typeof body !== "object" || body === null || Array.isArray(body))
    return fail(400, "invalid", "the body must be a JSON object");
  const unknown = Object.keys(body).filter((k) => !allowed.includes(k));
  if (unknown.length > 0) return fail(400, "invalid", `unknown field: ${unknown.join(", ")}`);
  return body as Record<string, unknown>;
}

/** A string of `min`..`max` characters once trimmed. */
function text(value: unknown, field: string, min: number, max: number): string | RouteEnvelope {
  if (typeof value !== "string") return fail(400, "invalid", `${field} must be a string`);
  const s = value.trim();
  if (s.length < min || s.length > max)
    return fail(400, "invalid", `${field} must be ${min} to ${max} characters`);
  return s;
}

function labelValue(ctx: Context, value: unknown): string | null | RouteEnvelope {
  if (value === null) return null;
  if (typeof value !== "string" || !isLabel(ctx, value))
    return fail(400, "invalid", "label must be one of the configured labels, or null");
  return value;
}

const isPriority = (v: unknown): v is Priority => PRIORITIES.includes(v as Priority);
const USER_ID = /^\d{1,20}$/;
const PRIORITY_LIST = PRIORITIES.join(", ");

export default definePlugin({
  onStart(ctx) {
    ctx.log.info("tickets ready", { staffRoles: ctx.config.staffRoles.length });
  },

  commands: {
    "ticket-panel": command({
      description: "Post the ticket panel (button to open a ticket)",
      ephemeral: true,
      permissions: ["ManageChannels"],
      options: {
        channel: {
          type: "channel",
          description: "Where to post it (defaults to the configured channel)",
        },
      },
      async run(ctx, interaction) {
        const target = interaction.options.channel
          ? ctx.server.channel({ id: interaction.options.channel.id })
          : ctx.server.channel(ctx.config.panelChannel);
        await target.send(panelMessage(ctx));
        await interaction.reply(`Ticket panel posted in ${target.mention}.`);
      },
    }),
  },

  components: {
    /** Panel button: asks for a subject first. */
    async open(ctx, interaction) {
      const open = await openTickets(ctx, interaction.user.id);
      if (open.length >= ctx.config.maxOpenPerMember) {
        const ticket = await getTicket(ctx, open[0] ?? 0);
        await interaction.reply({
          content: ticket
            ? `You already have an open ticket: <#${ticket.channelId}>.`
            : "You already have an open ticket.",
          ephemeral: true,
        });
        return;
      }
      await interaction.showModal({
        id: "open",
        title: "Open a ticket",
        fields: [
          {
            id: "subject",
            label: "Subject",
            style: "short",
            required: true,
            maxLength: 100,
            placeholder: "What is it about?",
          },
          {
            id: "description",
            label: "Details",
            style: "paragraph",
            required: false,
            maxLength: 1000,
          },
        ],
      });
    },

    /** "Close" button in the ticket: confirmation first (ephemeral). */
    async close(ctx, interaction) {
      const ticket = await closable(ctx, interaction);
      if (!ticket) return;
      await interaction.reply({
        ephemeral: true,
        content: `Close ticket #${ticket.number}? The channel will be deleted.`,
        components: [
          {
            type: "row",
            components: [
              {
                type: "button",
                id: `close-confirm:${ticket.number}`,
                label: "Close ticket",
                style: "danger",
              },
              {
                type: "button",
                id: `close-cancel:${ticket.number}`,
                label: "Cancel",
                style: "secondary",
              },
            ],
          },
        ],
      });
    },

    async "close-cancel"(_ctx, interaction) {
      await interaction.update({ content: "The ticket stays open.", components: [] });
    },

    async "close-confirm"(ctx, interaction) {
      const ticket = await closable(ctx, interaction);
      if (!ticket) return;
      // Answer first: the channel (and this message) is about to disappear.
      await interaction.update({ content: `Closing ticket #${ticket.number}…`, components: [] });
      const by = person(interaction.user, interaction.member);
      await closeTicket(ctx, ticket, by);
    },
  },

  modals: {
    /** Modal submit: creates the private channel. */
    async open(ctx, interaction) {
      await interaction.defer({ ephemeral: true });
      const user = interaction.user;
      if ((await openTickets(ctx, user.id)).length >= ctx.config.maxOpenPerMember) {
        await interaction.reply("You already have an open ticket.");
        return;
      }
      const { channel } = await openTicket(ctx, {
        user,
        member: interaction.member,
        subject: (interaction.fields["subject"] ?? "").trim() || "Ticket",
        description: (interaction.fields["description"] ?? "").trim(),
        label: null,
        source: "discord",
      });
      await interaction.reply(`Your ticket is open: ${channel.mention}`);
    },
  },

  events: {
    /** Activity of ticket channels: who and when, never what (the content is not stored). */
    async messageCreate(ctx, message) {
      if (message.author.bot) return;
      const n = await ctx.kv.get<number>(channelKey(message.channel.id));
      if (n === undefined) return;
      await ctx.kv.increment(activityKey(n));
      await ctx.kv.set(lastActivityKey(n), message.createdAt.toISOString());
    },
  },

  // Literal paths before parameters: the runtime prefers them anyway, the test harness takes
  // the first route that matches.
  routes: defineRoutes<Routes>({
    // ── members: their own tickets

    "GET /tickets/mine": {
      access: "member",
      async handler(ctx, request) {
        const viewer = memberViewer(request.viewer);
        if (failed(viewer)) return viewer;
        return { items: await myTickets(ctx, viewer.user.id) };
      },
    },

    "GET /tickets/mine/:id": {
      access: "member",
      async handler(ctx, request) {
        const viewer = memberViewer(request.viewer);
        if (failed(viewer)) return viewer;
        const ticket = await ticketById(ctx, request.params.id);
        // Someone else's ticket does not exist for the viewer.
        if (failed(ticket) || ticket.author.id !== viewer.user.id)
          return fail(404, "not_found", "no such ticket");
        return myDetail(ctx, ticket);
      },
    },

    "POST /tickets": {
      access: "member",
      async handler(ctx, request) {
        const viewer = memberViewer(request.viewer);
        if (failed(viewer)) return viewer;
        const body = objectBody(request.body, ["subject", "description", "label"]);
        if (failed(body)) return body;
        const subject = text(body["subject"], "subject", 3, 100);
        if (failed(subject)) return subject;
        const description = text(body["description"], "description", 10, 1000);
        if (failed(description)) return description;
        const label = body["label"] === undefined ? null : labelValue(ctx, body["label"]);
        if (failed(label)) return label;
        const open = await openTickets(ctx, viewer.user.id);
        if (open.length >= ctx.config.maxOpenPerMember)
          return fail(409, "limit", `you already have ${open.length} open ticket(s)`);
        const { ticket } = await openTicket(ctx, {
          user: viewer.user,
          member: viewer.member,
          subject,
          description,
          label,
          source: "portal",
        });
        return { status: 201, body: await myView(ctx, ticket) };
      },
    },

    // ── staff: a staff role, the server owner or a Cicord admin

    "GET /tickets": {
      access: "moderator",
      async handler(ctx, request) {
        const reader = staffReader(ctx, request.viewer);
        if (failed(reader)) return reader;
        const { status, assignee, priority, label } = request.query;
        const f: TicketFilters = {};
        if (status !== undefined) {
          if (status !== "open" && status !== "closed")
            return fail(400, "invalid", "status must be open or closed");
          f.status = status;
        }
        if (assignee !== undefined) {
          if (assignee === "none") f.assignee = null;
          else if (assignee === "me") {
            if (!reader) return fail(400, "invalid", "assignee=me needs a portal viewer");
            f.assignee = reader.id;
          } else if (USER_ID.test(assignee)) f.assignee = assignee;
          else return fail(400, "invalid", "assignee must be a user id, me or none");
        }
        if (priority !== undefined) {
          if (!isPriority(priority))
            return fail(400, "invalid", `priority must be one of ${PRIORITY_LIST}`);
          f.priority = priority;
        }
        if (label !== undefined) {
          if (label === "none") f.label = null;
          else if (isLabel(ctx, label)) f.label = label;
          else return fail(400, "invalid", "label must be a configured label key or none");
        }
        return { items: await listTickets(ctx, f) };
      },
    },

    "GET /tickets/:id": {
      access: "moderator",
      async handler(ctx, request) {
        const reader = staffReader(ctx, request.viewer);
        if (failed(reader)) return reader;
        const ticket = await ticketById(ctx, request.params.id);
        if (failed(ticket)) return ticket;
        return staffDetail(ctx, ticket);
      },
    },

    "GET /staff": {
      access: "moderator",
      async handler(ctx, request) {
        const reader = staffReader(ctx, request.viewer);
        if (failed(reader)) return reader;
        return { items: await listStaff(ctx, reader) };
      },
    },

    "POST /tickets/:id/assign": {
      access: "moderator",
      async handler(ctx, request) {
        const me = staffViewer(ctx, request.viewer);
        if (failed(me)) return me;
        const ticket = await ticketById(ctx, request.params.id);
        if (failed(ticket)) return ticket;
        const body = objectBody(request.body, ["userId"]);
        if (failed(body)) return body;
        const userId = body["userId"];
        let assignee: Person | null;
        if (userId === null) assignee = null;
        else if (userId === "me") assignee = me;
        else if (typeof userId === "string" && USER_ID.test(userId)) {
          const member = await ctx.server.member(userId);
          if (!member) return fail(400, "invalid", "no such member");
          if (!isStaff(ctx, member)) return fail(400, "invalid", "the assignee must be staff");
          assignee = person(member.user, member);
        } else return fail(400, "invalid", "userId must be a user id, me or null");

        if ((ticket.assignee?.id ?? null) !== (assignee?.id ?? null)) {
          ticket.assignee = assignee;
          if (assignee) addEvent(ticket, "assigned", me, assignee.displayName);
          else addEvent(ticket, "unassigned", me);
          await saveTicket(ctx, ticket);
          await notice(
            ctx,
            ticket,
            assignee
              ? `Assigned to **${escapeMarkdown(assignee.displayName)}**.`
              : `Unassigned by **${escapeMarkdown(me.displayName)}**.`,
          );
        }
        return staffView(ctx, ticket);
      },
    },

    "PATCH /tickets/:id": {
      access: "moderator",
      async handler(ctx, request) {
        const me = staffViewer(ctx, request.viewer);
        if (failed(me)) return me;
        const ticket = await ticketById(ctx, request.params.id);
        if (failed(ticket)) return ticket;
        const body = objectBody(request.body, ["priority", "label"]);
        if (failed(body)) return body;
        if (body["priority"] === undefined && body["label"] === undefined)
          return fail(400, "invalid", "nothing to change: give priority or label");
        const priority = body["priority"];
        if (priority !== undefined && !isPriority(priority))
          return fail(400, "invalid", `priority must be one of ${PRIORITY_LIST}`);
        const label = body["label"] === undefined ? undefined : labelValue(ctx, body["label"]);
        if (failed(label)) return label;

        let changed = false;
        if (priority !== undefined && priority !== ticket.priority) {
          ticket.priority = priority;
          addEvent(ticket, "priority", me, priority);
          changed = true;
        }
        if (label !== undefined && label !== ticket.label) {
          ticket.label = label;
          addEvent(ticket, "label", me, label ?? "none");
          changed = true;
        }
        if (changed) await saveTicket(ctx, ticket);
        return staffView(ctx, ticket);
      },
    },

    "POST /tickets/:id/close": {
      access: "moderator",
      async handler(ctx, request) {
        const me = staffViewer(ctx, request.viewer);
        if (failed(me)) return me;
        const ticket = await ticketById(ctx, request.params.id);
        if (failed(ticket)) return ticket;
        const body = objectBody(request.body, ["reason"], true);
        if (failed(body)) return body;
        const reason = body["reason"] === undefined ? "" : text(body["reason"], "reason", 0, 500);
        if (failed(reason)) return reason;
        if (ticket.status !== "open") return fail(409, "closed", "the ticket is already closed");
        return staffView(ctx, await closeTicket(ctx, ticket, me, reason || undefined));
      },
    },

    "POST /tickets/:id/reopen": {
      access: "moderator",
      async handler(ctx, request) {
        const me = staffViewer(ctx, request.viewer);
        if (failed(me)) return me;
        const ticket = await ticketById(ctx, request.params.id);
        if (failed(ticket)) return ticket;
        if (ticket.status === "open") return fail(409, "open", "the ticket is already open");
        return staffView(ctx, await reopenTicket(ctx, ticket, me));
      },
    },

    "POST /tickets/:id/messages": {
      access: "moderator",
      async handler(ctx, request) {
        const me = staffViewer(ctx, request.viewer);
        if (failed(me)) return me;
        const ticket = await ticketById(ctx, request.params.id);
        if (failed(ticket)) return ticket;
        const body = objectBody(request.body, ["content"]);
        if (failed(body)) return body;
        const content = text(body["content"], "content", 1, 2000);
        if (failed(content)) return content;
        if (ticket.status !== "open") return fail(409, "closed", "the ticket is closed");
        const channel = await liveChannel(ctx, ticket);
        if (!channel) return fail(409, "closed", "the ticket channel no longer exists");
        return { status: 201, body: { id: await postReply(ctx, ticket, channel, me, content) } };
      },
    },
  }),
});
