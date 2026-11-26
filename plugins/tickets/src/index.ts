import { relay } from "./relay.ts";
import english from "../locales/en.json";
import { ordered } from "./ordered.ts";
import * as sdk from "@cicord/sdk";
import { renderTranscript, withdrawCopies } from "./transcript.ts";
import { maintenance, receivedReply } from "./lifecycle.ts";
import { privacy } from "./privacy.ts";
import {
  command,
  query,
  action,
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
  types,
  ticketType,
  mayRead,
  mayReadTranscript,
  relayAllowed,
  publish,
  allTickets,
  addEvent,
  channelKey,
  closeTicket,
  escapeMarkdown,
  getTicket,
  isLabel,
  isStaff,
  listStaff,
  listTickets,
  liveChannel,
  myDetail,
  myTickets,
  myView,
  notice,
  numberOf,
  openTicket,
  requestTicket,
  provisionTicket,
  OpenLimit,
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
    await interaction.reply({ content: ctx.i18n.t("alreadyClosed"), ephemeral: true });
    return undefined;
  }
  if (!mayRead(ctx, ticket, interaction.member, true)) {
    await interaction.reply({
      content: ctx.i18n.t("closeDenied"),
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

async function mayReadModmail(ctx: Context, t: Ticket, viewer?: Member) {
  if (!viewer || !mayRead(ctx, t, viewer, true)) return false;
  return t.status === "closed" ? mayReadTranscript(ctx, t, viewer) : relayAllowed(ctx, t, viewer);
}

async function staffTicket(ctx: Context, id: string, viewer: Viewer) {
  const t = await ticketById(ctx, id);
  return failed(t) || !mayRead(ctx, t, viewer?.member)
    ? fail(404, "not_found", "no such ticket")
    : t;
}

async function rate(ctx: Context, t: Ticket, userId: string, rating: number) {
  if (
    t.status !== "closed" ||
    t.author.id !== userId ||
    !Number.isInteger(rating) ||
    rating < 1 ||
    rating > 5
  )
    return false;
  if (t.rating === undefined) {
    t.rating = rating;
    await saveTicket(ctx, t);
    await publish(ctx, t, "rated");
  }
  return true;
}

export default definePlugin({
  privacy: { export: privacy.export, erase: ordered(privacy.erase) },
  schedules: { maintenance: { cron: "* * * * *", run: ordered(maintenance) } },
  tasks: {
    provision: ordered(async (ctx, payload) => {
      if (
        !payload ||
        typeof payload !== "object" ||
        Array.isArray(payload) ||
        typeof payload.number !== "number"
      )
        return;
      const t = await getTicket(ctx, payload.number);
      if (t) await provisionTicket(ctx, t);
    }),
  },
  queries: {
    openFor: query({
      async run(ctx, input, call) {
        const { userId } = input as { userId: string };
        if (call.onBehalfOf?.access === "scoped") return { tickets: [] };
        const viewer = call.onBehalfOf && (await ctx.server.member(call.onBehalfOf.userId));
        if (!viewer) return { tickets: [] };
        const tickets = [];
        for (const n of await openTickets(ctx, userId)) {
          const t = await getTicket(ctx, n);
          if (t && mayRead(ctx, t, viewer, true))
            tickets.push({ id: t.id, type: t.type, subject: t.subject, status: t.status });
        }
        return { tickets };
      },
    }),
  },
  subscriptions: {
    "moderation.appeal": ordered(async (ctx, payload, meta) => {
      if (
        !ctx.features.enabled("appealUpdates") ||
        !meta ||
        !payload ||
        typeof payload !== "object" ||
        Array.isArray(payload)
      )
        return;
      const { case: caseNumber, userId, status } = payload;
      if (
        typeof caseNumber !== "number" ||
        typeof userId !== "string" ||
        typeof status !== "string"
      )
        return;
      for (const t of await allTickets(ctx)) {
        if (
          t.author.id === userId &&
          t.appeal?.number === caseNumber &&
          t.appeal.bot === meta.publisher.bot &&
          t.appeal.instance === meta.publisher.instance &&
          t.appeal.status !== status
        ) {
          t.appeal.status = status;
          await saveTicket(ctx, t);
        }
      }
    }),
  },
  actions: {
    open: action({
      run: ordered(async (ctx, input, call) => {
        const data = input as {
          userId: string;
          subject: string;
          type?: string;
          description?: string;
          caseNumber?: number;
        };
        const isAppeal = call.caller.plugin === "moderation" && data.caseNumber !== undefined;
        const key = data.type ?? (isAppeal ? ctx.config.appealType : undefined);
        if (isAppeal && !key && types(ctx).length > 1)
          throw new Error("Configure appealType for moderation appeals");
        if (
          call.onBehalfOf?.access === "scoped" &&
          (!isAppeal ||
            call.onBehalfOf.resourceScope?.kind !== "case" ||
            call.onBehalfOf.resourceScope.id !== String(data.caseNumber) ||
            data.userId !== call.onBehalfOf.userId)
        )
          throw new Error("Case scope does not authorize this ticket");
        const type = ticketType(ctx, key);
        if (!type || !call.onBehalfOf) throw new Error("Ticket author required");
        const viewer = await ctx.server.member(call.onBehalfOf.userId);
        if (call.onBehalfOf.userId !== data.userId && !isStaff(ctx, viewer, type.key))
          throw new Error("Ticket staff required");
        const request = {
          caller: call.caller.bot + "/" + call.caller.instance,
          key: call.idempotencyKey,
        };
        const previous = (await allTickets(ctx)).find(
          (t) => t.request?.caller === request.caller && t.request.key === request.key,
        );
        if (previous) {
          if (previous.author.id !== data.userId) throw new Error("Idempotency key already used");
          return {
            id: previous.id,
            ...(previous.channelId ? { channelId: previous.channelId } : {}),
          };
        }
        const member = await ctx.server.member(data.userId);
        if ((await openTickets(ctx, data.userId)).length >= ctx.config.maxOpenPerMember)
          throw new Error("Open ticket limit reached");
        const user = member?.user ?? {
          id: data.userId,
          displayName: data.userId,
          username: data.userId,
          bot: false,
          mention: "<@" + data.userId + ">",
        };
        const appeal =
          data.caseNumber && call.caller.plugin === "moderation"
            ? { number: data.caseNumber, bot: call.caller.bot, instance: call.caller.instance }
            : undefined;
        return requestTicket(ctx, {
          user,
          member,
          appeal,
          request,
          subject: data.subject,
          description: data.description ?? "",
          source: "interop",
          label: null,
          type: type.key,
        });
      }),
    }),
  },
  ...(sdk.sdkFeatures?.contextMenus
    ? {
        contextMenus: {
          "Open ticket on message": {
            type: "message",
            run: ordered(async (ctx, i) => {
              if (
                !i.member ||
                (await openTickets(ctx, i.user.id)).length >= ctx.config.maxOpenPerMember
              ) {
                await i.reply({ content: ctx.i18n.t("openLimit"), ephemeral: true });
                return;
              }
              const { ticket, channel } = await openTicket(ctx, {
                user: i.user,
                member: i.member,
                subject: ctx.i18n.t("messageReport"),
                description: "",
                source: "discord",
                label: null,
              });
              const relation = ctx.server.compareAudience(i.target.channel, channel);
              if (relation === "same" || relation === "narrower") {
                ticket.description = i.target.url;
                await saveTicket(ctx, ticket);
                await channel.send({
                  content: i.target.url,
                  allowedMentions: { users: false, roles: false, everyone: false },
                });
              }
              await i.reply({
                content: ctx.i18n.t("openedChannel", { channel: channel.mention }),
                ephemeral: true,
              });
            }),
          },
        },
      }
    : {}),
  async onStart(ctx) {
    await withdrawCopies(ctx);
    ctx.features.report?.(
      "messageContextMenu",
      Boolean(sdk.sdkFeatures?.contextMenus),
      sdk.sdkFeatures?.contextMenus ? undefined : "SDK-13 message context menus unavailable",
    );
    const keys = new Set<string>();
    for (const type of types(ctx)) {
      if (keys.has(type.key)) throw new Error("Duplicate ticket type: " + type.key);
      keys.add(type.key);
    }
    if (ctx.config.modmailType && !keys.has(ctx.config.modmailType))
      throw new Error("Unknown modmail type");
    ctx.log.info("tickets ready", { staffRoles: ctx.config.staffRoles.length });
  },

  commands: {
    "ticket-panel": command({
      description: english["commands.ticket-panel.description"],
      ephemeral: true,
      permissions: ["ManageChannels"],
      options: {
        channel: {
          type: "channel",
          description: english["commands.ticket-panel.options.channel.description"],
        },
      },
      async run(ctx, interaction) {
        const target = interaction.options.channel
          ? ctx.server.channel({ id: interaction.options.channel.id })
          : ctx.server.channel(ctx.config.panelChannel);
        await target.send(panelMessage(ctx));
        await interaction.reply(ctx.i18n.t("panelPosted", { channel: target.mention }));
      },
    }),
  },

  components: {
    claim: ordered(async (ctx, i) => {
      const t = await getTicket(ctx, numberOf(i.componentId) ?? 0);
      if (!t || t.status !== "open" || !mayRead(ctx, t, i.member)) {
        await i.reply({ content: ctx.i18n.t("unavailable"), ephemeral: true });
        return;
      }
      if (!t.assignee) {
        t.assignee = person(i.user, i.member);
        addEvent(t, "assigned", t.assignee, t.assignee.displayName);
        await saveTicket(ctx, t);
      }
      await i.reply({
        content: ctx.i18n.t("claimed", { staff: t.assignee.displayName }),
        ephemeral: true,
      });
    }),
    rate: ordered(async (ctx, i) => {
      const [, id, value] = i.componentId.split(":");
      const t = await getTicket(ctx, Number(id));
      const ok = t && (await rate(ctx, t, i.user.id, Number(value)));
      await i.reply({
        content: ok ? ctx.i18n.t("rated") : ctx.i18n.t("ratingUnavailable"),
        ephemeral: true,
      });
    }),
    /** Panel button: asks for a subject first. */
    async open(ctx, interaction) {
      const open = await openTickets(ctx, interaction.user.id);
      if (open.length >= ctx.config.maxOpenPerMember) {
        const ticket = await getTicket(ctx, open[0] ?? 0);
        await interaction.reply({
          content: ticket
            ? ctx.i18n.t("existingChannel", { channel: "<#" + ticket.channelId + ">" })
            : ctx.i18n.t("alreadyOpen"),
          ephemeral: true,
        });
        return;
      }
      const key = interaction.componentId.split(":")[1];
      const type = ticketType(ctx, key);
      if (!type) {
        await interaction.reply({ content: ctx.i18n.t("typeUnavailable"), ephemeral: true });
        return;
      }
      await interaction.showModal({
        id: key ? "open:" + key : "open",
        title: key ? type.name : ctx.i18n.t("open"),
        fields: [
          {
            id: "subject",
            label: ctx.i18n.t("subject"),
            style: "short",
            required: true,
            maxLength: 100,
            placeholder: ctx.i18n.t("subjectHint"),
          },
          ...(type.fields?.length
            ? type.fields.map((f, i) => ({
                id: "field" + i,
                label: f.label,
                style: "paragraph" as const,
                required: f.required,
                maxLength: 500,
              }))
            : [
                {
                  id: "description",
                  label: ctx.i18n.t("details"),
                  style: "paragraph" as const,
                  required: false,
                  maxLength: 1000,
                },
              ]),
        ],
      });
    },

    /** "Close" button in the ticket: confirmation first (ephemeral). */
    async close(ctx, interaction) {
      const ticket = await closable(ctx, interaction);
      if (!ticket) return;
      await interaction.reply({
        ephemeral: true,
        content: ctx.i18n.t(
          ticketType(ctx, ticket.type)?.retainSourceForTranscript
            ? "confirmRetain"
            : "confirmClose",
          { number: ticket.number },
        ),
        components: [
          {
            type: "row",
            components: [
              {
                type: "button",
                id: `close-confirm:${ticket.number}`,
                label: ctx.i18n.t("closeTicket"),
                style: "danger",
              },
              {
                type: "button",
                id: `close-cancel:${ticket.number}`,
                label: ctx.i18n.t("cancel"),
                style: "secondary",
              },
            ],
          },
        ],
      });
    },

    async "close-cancel"(ctx, interaction) {
      await interaction.update({ content: ctx.i18n.t("staysOpen"), components: [] });
    },

    "close-confirm": ordered(async (ctx, interaction) => {
      const ticket = await closable(ctx, interaction);
      if (!ticket) return;
      // Answer first: the channel (and this message) is about to disappear.
      await interaction.update({
        content: ctx.i18n.t("closing", { number: ticket.number }),
        components: [],
      });
      const by = person(interaction.user, interaction.member);
      await closeTicket(ctx, ticket, by);
    }),
  },

  modals: {
    /** Modal submit: creates the private channel. */
    open: ordered(async (ctx, interaction) => {
      await interaction.defer({ ephemeral: true });
      const user = interaction.user;
      if ((await openTickets(ctx, user.id)).length >= ctx.config.maxOpenPerMember) {
        await interaction.reply(ctx.i18n.t("alreadyOpen"));
        return;
      }
      const type = ticketType(ctx, interaction.modalId.split(":")[1]);
      if (!type) {
        await interaction.reply(ctx.i18n.t("typeUnavailablePeriod"));
        return;
      }
      const answers = type.fields
        ?.map((f, i) => f.label + ": " + (interaction.fields["field" + i] ?? ""))
        .join("\n");
      const { channel } = await openTicket(ctx, {
        type: type.key,
        user,
        member: interaction.member,
        subject: (interaction.fields["subject"] ?? "").trim() || ctx.i18n.t("ticket"),
        description: answers ?? (interaction.fields["description"] ?? "").trim(),
        label: null,
        source: "discord",
      });
      await interaction.reply(ctx.i18n.t("yourChannel", { channel: channel.mention }));
    }),
  },

  events: {
    serverAvailable: ordered(async (ctx) => {
      await withdrawCopies(ctx);
    }),
    serverJoin: ordered(async (ctx) => {
      await withdrawCopies(ctx);
    }),
    channelUpdate: ordered(async (ctx, e) => {
      await withdrawCopies(ctx, e.channel.id);
    }),
    roleUpdate: ordered(async (ctx) => {
      await withdrawCopies(ctx);
    }),
    roleDelete: ordered(async (ctx) => {
      await withdrawCopies(ctx);
    }),
    directMessage: ordered(async (ctx, m) => {
      const member = await ctx.server.member(m.author.id);
      if (!member || m.author.bot) return;
      const text = [m.content, ...m.attachments.map((a) => a.url)].filter(Boolean).join("\n");
      const type = ticketType(ctx, ctx.config.modmailType);
      if (!type) return;
      const open = await openTickets(ctx, member.id);
      for (const id of open) {
        const t = await getTicket(ctx, id);
        if (t?.source !== "modmail" || t.status !== "open" || t.author.id !== member.id) continue;
        const delivered = await relay(
          ctx,
          t,
          "inbound",
          person(m.author, member),
          (text || ctx.i18n.t("attachment")).slice(0, 2000),
          m.id,
          m.createdAt,
        );
        if (!delivered) {
          ctx.log.warn("Modmail withheld after permission change", { ticket: t.id });
          await member.send(ctx.i18n.t("relayDenied"));
        }
        return;
      }
      if (open.length >= ctx.config.maxOpenPerMember) {
        await member.send(ctx.i18n.t("openLimit"));
        return;
      }
      const { ticket } = await openTicket(ctx, {
        user: m.author,
        member,
        type: type.key,
        source: "modmail",
        subject: ctx.i18n.t("modmail"),
        description: "",
        label: null,
      });
      const delivered = await relay(
        ctx,
        ticket,
        "inbound",
        person(m.author, member),
        (text || ctx.i18n.t("attachment")).slice(0, 2000),
        m.id,
        m.createdAt,
      );
      if (!delivered) await member.send(ctx.i18n.t("relayDenied"));
    }),
    /** Activity of ticket channels: who and when, never what (the content is not stored). */
    messageCreate: ordered(async (ctx, message) => {
      if (message.author.bot) return;
      const n = await ctx.kv.get<number>(channelKey(message.channel.id));
      if (n === undefined) return;
      const t = await getTicket(ctx, n);
      if (!t || t.status !== "open") return;
      const staff = isStaff(ctx, message.member, t.type) && message.author.id !== t.author.id;
      if (t.source === "modmail" && staff) {
        const body =
          [message.content, ...message.attachments.map((a) => a.url)]
            .filter(Boolean)
            .join("\n")
            .slice(0, 2000) || ctx.i18n.t("attachment");
        const delivered = await relay(
          ctx,
          t,
          "outbound",
          person(message.author, message.member),
          body,
          message.id,
          message.createdAt,
        );
        if (!delivered)
          ctx.log.warn("Outbound modmail withheld after permission change", { ticket: t.id });
        return;
      }
      await ctx.kv.increment(activityKey(n));
      await receivedReply(ctx, t, message.createdAt, staff);
    }),
  },

  // Literal paths before parameters: the runtime prefers them anyway, the test harness takes
  // the first route that matches.
  routes: defineRoutes<Routes>({
    // ── members: their own tickets

    "GET /types": {
      access: "member",
      handler(ctx) {
        return { items: types(ctx).map(({ key, name }) => ({ key, name })) };
      },
    },
    "GET /tickets/stats": {
      access: "member",
      async handler(ctx, req) {
        if (!isStaff(ctx, req.viewer?.member))
          return fail(403, "forbidden", "Ticket staff required");
        const ratings = (await allTickets(ctx))
          .filter((t) => mayRead(ctx, t, req.viewer?.member) && t.rating !== undefined)
          .map((t) => t.rating!);
        return {
          rated: ratings.length,
          mean: ratings.length ? ratings.reduce((a, b) => a + b, 0) / ratings.length : null,
        };
      },
    },
    "GET /tickets/:id/transcript": {
      access: "member",
      async handler(ctx, req) {
        const t = await ticketById(ctx, req.params.id);
        if (failed(t) || !(await mayReadTranscript(ctx, t, req.viewer?.member)))
          return fail(404, "not_found", "No transcript");
        const format = req.query.format ?? "html";
        if (format !== "html" && format !== "markdown")
          return fail(400, "invalid", "Unknown format");
        const content = await renderTranscript(ctx, t, format);
        return content === undefined
          ? fail(404, "not_found", "No transcript")
          : { format, content };
      },
    },
    "GET /tickets/:id/cases": {
      access: "member",
      async handler(ctx, req) {
        const t = await staffTicket(ctx, req.params.id, req.viewer);
        if (failed(t)) return t;
        if (!ctx.features.enabled("caseContext")) return { cases: [] };
        const result = (await ctx.plugins.query("moderation", "cases", {
          userId: t.author.id,
          limit: 10,
        })) as {
          cases: { number: number; action: string; status: string; reason: string; at: string }[];
        };
        return {
          cases: result.cases.map(({ number, action, status, reason, at }) => ({
            number,
            action,
            status,
            reason,
            at,
          })),
        };
      },
    },
    "POST /tickets/:id/notes": {
      access: "member",
      handler: ordered(async (ctx, req) => {
        const t = await staffTicket(ctx, req.params.id, req.viewer);
        if (failed(t)) return t;
        const body = objectBody(req.body, ["content"]);
        if (failed(body)) return body;
        const content = text(body["content"], "content", 1, 2000);
        if (failed(content)) return content;
        t.notes = [
          ...t.notes,
          {
            by: person(req.viewer!.user, req.viewer!.member),
            at: new Date().toISOString(),
            content,
          },
        ].slice(-100);
        await saveTicket(ctx, t);
        return staffDetail(ctx, t);
      }),
    },
    "POST /tickets/:id/rating": {
      access: "member",
      handler: ordered(async (ctx, req) => {
        const t = await ticketById(ctx, req.params.id);
        if (failed(t) || t.author.id !== req.viewer?.user.id)
          return fail(404, "not_found", "No such ticket");
        const body = objectBody(req.body, ["rating"]);
        if (failed(body)) return body;
        if (
          typeof body["rating"] !== "number" ||
          !(await rate(ctx, t, t.author.id, body["rating"]))
        )
          return fail(400, "invalid", "Rate a closed ticket from 1 to 5");
        return { rating: t.rating! };
      }),
    },
    "GET /tickets/mine": {
      access: "member",
      async handler(ctx, request) {
        const viewer = memberViewer(request.viewer);
        if (failed(viewer)) return viewer;
        return { items: await myTickets(ctx, viewer.member) };
      },
    },

    "GET /tickets/mine/:id": {
      access: "member",
      async handler(ctx, request) {
        const viewer = memberViewer(request.viewer);
        if (failed(viewer)) return viewer;
        const ticket = await ticketById(ctx, request.params.id);
        // Someone else's ticket does not exist for the viewer.
        if (
          failed(ticket) ||
          ticket.author.id !== viewer.user.id ||
          !mayRead(ctx, ticket, viewer.member, true)
        )
          return fail(404, "not_found", "no such ticket");
        if (ticket.source === "modmail" && !(await mayReadModmail(ctx, ticket, viewer.member)))
          return fail(404, "not_found", "No verified modmail source");
        return myDetail(ctx, ticket);
      },
    },

    "POST /tickets": {
      access: "member",
      handler: ordered(async (ctx, request) => {
        const viewer = memberViewer(request.viewer);
        if (failed(viewer)) return viewer;
        const body = objectBody(request.body, ["subject", "description", "label", "type"]);
        if (failed(body)) return body;
        const type = body["type"];
        if (type !== undefined && (typeof type !== "string" || !ticketType(ctx, type)))
          return fail(400, "invalid", "Unknown ticket type");
        const subject = text(body["subject"], "subject", 3, 100);
        if (failed(subject)) return subject;
        const description = text(body["description"], "description", 10, 1000);
        if (failed(description)) return description;
        const label = body["label"] === undefined ? null : labelValue(ctx, body["label"]);
        if (failed(label)) return label;
        const open = await openTickets(ctx, viewer.user.id);
        if (open.length >= ctx.config.maxOpenPerMember)
          return fail(409, "limit", `you already have ${open.length} open ticket(s)`);
        try {
          const { ticket } = await openTicket(ctx, {
            user: viewer.user,
            member: viewer.member,
            subject,
            description,
            label,
            source: "portal",
            type,
          });
          return { status: 201, body: await myView(ctx, ticket) };
        } catch (error) {
          if (error instanceof OpenLimit) return fail(409, "limit", error.message);
          throw error;
        }
      }),
    },

    // ── staff: a staff role, the server owner or a Cicord admin

    "GET /tickets": {
      access: "member",
      async handler(ctx, request) {
        const reader = staffViewer(ctx, request.viewer);
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
        return { items: await listTickets(ctx, f, request.viewer?.member) };
      },
    },

    "GET /tickets/:id": {
      access: "member",
      async handler(ctx, request) {
        const reader = staffViewer(ctx, request.viewer);
        if (failed(reader)) return reader;
        const ticket = await staffTicket(ctx, request.params.id, request.viewer);
        if (failed(ticket)) return ticket;
        if (
          ticket.status === "closed" &&
          ticket.expiresAt &&
          !(await mayReadTranscript(ctx, ticket, request.viewer?.member))
        )
          return fail(404, "not_found", "No verified transcript source");
        if (
          ticket.source === "modmail" &&
          !(await mayReadModmail(ctx, ticket, request.viewer?.member))
        )
          return fail(404, "not_found", "No verified modmail source");
        return staffDetail(ctx, ticket);
      },
    },

    "GET /staff": {
      access: "member",
      async handler(ctx, request) {
        const reader = staffViewer(ctx, request.viewer);
        if (failed(reader)) return reader;
        const type = request.query.type;
        if (type && !isStaff(ctx, request.viewer?.member, type))
          return fail(403, "forbidden", "Type access required");
        const staff = new Map<string, Person>();
        for (const cfg of types(ctx))
          if ((!type || type === cfg.key) && isStaff(ctx, request.viewer?.member, cfg.key))
            for (const member of await listStaff(ctx, reader, cfg.key))
              staff.set(member.id, member);
        return {
          items: [...staff.values()].sort((a, b) => a.displayName.localeCompare(b.displayName)),
        };
      },
    },

    "POST /tickets/:id/assign": {
      access: "member",
      handler: ordered(async (ctx, request) => {
        const me = staffViewer(ctx, request.viewer);
        if (failed(me)) return me;
        const ticket = await staffTicket(ctx, request.params.id, request.viewer);
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
          if (!isStaff(ctx, member, ticket.type))
            return fail(400, "invalid", "the assignee must be staff");
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
              ? ctx.i18n.t("assigned", { staff: escapeMarkdown(assignee.displayName) })
              : ctx.i18n.t("unassigned", { staff: escapeMarkdown(me.displayName) }),
            [me.id, ...(assignee ? [assignee.id] : [])],
          );
        }
        return staffView(ctx, ticket);
      }),
    },

    "PATCH /tickets/:id": {
      access: "member",
      handler: ordered(async (ctx, request) => {
        const me = staffViewer(ctx, request.viewer);
        if (failed(me)) return me;
        const ticket = await staffTicket(ctx, request.params.id, request.viewer);
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
          ticket.labels = label ? [label] : [];
          addEvent(ticket, "label", me, label ?? "none");
          changed = true;
        }
        if (changed) await saveTicket(ctx, ticket);
        return staffView(ctx, ticket);
      }),
    },

    "POST /tickets/:id/close": {
      access: "member",
      handler: ordered(async (ctx, request) => {
        const me = staffViewer(ctx, request.viewer);
        if (failed(me)) return me;
        const ticket = await staffTicket(ctx, request.params.id, request.viewer);
        if (failed(ticket)) return ticket;
        const body = objectBody(request.body, ["reason"], true);
        if (failed(body)) return body;
        const reason = body["reason"] === undefined ? "" : text(body["reason"], "reason", 0, 500);
        if (failed(reason)) return reason;
        if (ticket.status !== "open") return fail(409, "closed", "the ticket is already closed");
        return staffView(ctx, await closeTicket(ctx, ticket, me, reason || undefined));
      }),
    },

    "POST /tickets/:id/reopen": {
      access: "member",
      handler: ordered(async (ctx, request) => {
        const me = staffViewer(ctx, request.viewer);
        if (failed(me)) return me;
        const ticket = await staffTicket(ctx, request.params.id, request.viewer);
        if (failed(ticket)) return ticket;
        if (ticket.status === "open") return fail(409, "open", "the ticket is already open");
        return staffView(ctx, await reopenTicket(ctx, ticket, me));
      }),
    },

    "POST /tickets/:id/messages": {
      access: "member",
      handler: ordered(async (ctx, request) => {
        const me = staffViewer(ctx, request.viewer);
        if (failed(me)) return me;
        const ticket = await staffTicket(ctx, request.params.id, request.viewer);
        if (failed(ticket)) return ticket;
        const body = objectBody(request.body, ["content"]);
        if (failed(body)) return body;
        const content = text(body["content"], "content", 1, 2000);
        if (failed(content)) return content;
        if (ticket.status !== "open") return fail(409, "closed", "the ticket is closed");
        const channel = await liveChannel(ctx, ticket);
        if (!channel) return fail(409, "closed", "the ticket channel no longer exists");
        const id = await postReply(ctx, ticket, channel, me, content);
        return id
          ? { status: 201, body: { id } }
          : fail(403, "forbidden", "Cannot verify private message recipients");
      }),
    },
  }),
});
