import {
  command,
  definePlugin,
  type ComponentInteraction,
  type Context,
  type Json,
  type Permission,
  type RouteResponse,
} from "@cicord/sdk";
import {
  activityKey,
  channelKey,
  channelName,
  closeButton,
  getTicket,
  isStaff,
  lastActivityKey,
  listTickets,
  numberOf,
  openKey,
  openTickets,
  panelMessage,
  person,
  render,
  saveTicket,
  summaryEmbed,
  type Person,
  type Ticket,
} from "./tickets.ts";

const TICKET_PERMS: Permission[] = [
  "ViewChannel",
  "SendMessages",
  "ReadMessageHistory",
  "AttachFiles",
  "EmbedLinks",
];

/** The opener and the staff roles may close a ticket. */
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

      const participants = new Map<string, Person>();
      let messages = 0;
      try {
        const history = await ctx.server.channel({ id: ticket.channelId }).messages({ limit: 100 });
        for (const m of history) {
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
        closedBy: person(interaction.user, interaction.member),
        summary: { messages, participants: [...participants.values()] },
      };
      await saveTicket(ctx, closed);
      await ctx.kv.delete(openKey(ticket.author.id, ticket.number));
      await ctx.kv.delete(channelKey(ticket.channelId));
      await ctx.kv.delete(activityKey(ticket.number));
      await ctx.kv.increment("stats:closed");

      if (ctx.config.logChannel) {
        await ctx.server.channel(ctx.config.logChannel).send({
          embeds: [summaryEmbed(closed)],
          allowedMentions: { users: false, roles: false, everyone: false },
        });
      }
      try {
        await ctx.server.deleteChannel({ id: ticket.channelId }, `ticket #${ticket.number} closed`);
      } catch (error) {
        ctx.log.warn("tickets: could not delete the ticket channel", {
          ticket: ticket.number,
          error: String(error),
        });
      }
      ctx.log.info("ticket closed", { ticket: ticket.number, by: interaction.user.id, messages });
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
      const subject = (interaction.fields["subject"] ?? "").trim() || "Ticket";
      const description = (interaction.fields["description"] ?? "").trim();
      const author = person(user, interaction.member);
      const number = await ctx.kv.increment("seq");

      // Keys: "@everyone", a role key, "role:<id>" or "member:<id>".
      const overwrites: Record<string, { allow?: Permission[]; deny?: Permission[] }> = {
        "@everyone": { deny: ["ViewChannel"] },
        [`member:${user.id}`]: { allow: [...TICKET_PERMS] },
        // The bot keeps access even without Administrator.
        [`member:${ctx.bot.user.id}`]: { allow: [...TICKET_PERMS, "ManageChannels"] },
      };
      for (const role of ctx.config.staffRoles) overwrites[role] = { allow: [...TICKET_PERMS] };

      const channel = await ctx.server.createChannel({
        name: channelName(ctx.config.channelName, number, author.displayName),
        ...(ctx.config.category ? { category: ctx.config.category } : {}),
        topic: `#${number} · ${subject} · opened by ${author.displayName}`,
        overwrites,
      });

      const ticket: Ticket = {
        id: String(number),
        number,
        subject,
        description,
        status: "open",
        author,
        channelId: channel.id,
        createdAt: new Date().toISOString(),
      };
      await saveTicket(ctx, ticket);
      await ctx.kv.set(openKey(user.id, number), true);
      await ctx.kv.set(channelKey(channel.id), number);
      await ctx.kv.increment("stats:opened");

      const staff =
        ctx.config.staffRoles.map((r) => ctx.server.role(r).mention).join(" ") || "The team";
      await channel.send({
        content: render(ctx.config.welcomeMessage, {
          member: user.mention,
          staff,
          subject,
          number: String(number),
        }),
        embeds: [
          {
            title: `#${number} — ${subject}`,
            description: description || "_No details._",
            color: ctx.config.panel.color,
          },
        ],
        components: closeButton(number),
        allowedMentions: { users: true, roles: true },
      });
      await interaction.reply(`Your ticket is open: ${channel.mention}`);
      ctx.log.info("ticket opened", { ticket: number, member: user.id, channel: channel.id });
    },
  },

  events: {
    /** Activity of ticket channels (no MessageContent needed: only who and when). */
    async messageCreate(ctx, message) {
      if (message.author.bot) return;
      const n = await ctx.kv.get<number>(channelKey(message.channel.id));
      if (n === undefined) return;
      await ctx.kv.increment(activityKey(n));
      await ctx.kv.set(lastActivityKey(n), message.createdAt.toISOString());
    },
  },

  routes: {
    /** Tickets for the staff portal, newest first. `?status=open|closed`. */
    "GET /tickets": {
      access: "moderator",
      async handler(ctx, request): Promise<RouteResponse> {
        const status = request.query["status"];
        if (status !== undefined && status !== "open" && status !== "closed") {
          return {
            status: 400,
            body: { error: { code: "invalid", message: "status must be open or closed" } },
          };
        }
        return { items: (await listTickets(ctx, status)) as unknown as Json };
      },
    },
    "GET /tickets/:id": {
      access: "moderator",
      async handler(ctx, request): Promise<RouteResponse> {
        const ticket = await getTicket(ctx, Number(request.params["id"]));
        if (!ticket)
          return { status: 404, body: { error: { code: "not_found", message: "no such ticket" } } };
        return ticket as unknown as Json;
      },
    },
  },
});
