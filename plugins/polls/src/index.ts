import {
  command,
  definePlugin,
  defineRoutes,
  subcommand,
  type AllowedMentions,
  type AutocompleteInteraction,
  type ComponentInteraction,
  type Context,
  type FocusedOption,
  type Json,
  type Member,
  type Role,
  type User,
} from "@cicord/sdk";
import {
  MAX_CHOICES,
  closedEvent,
  findMessage,
  getPoll,
  listPolls,
  parseChoices,
  renderPoll,
  savePoll,
  suggestPolls,
  tally,
  voteKey,
  type Poll,
} from "./polls.ts";
import type { Routes } from "./routes.ts";

const HOUR = 3_600_000;

/** Closes a poll: final results, cancels the scheduled closing, publishes `polls.closed`. */
async function closePoll(ctx: Context, poll: Poll, by: string | null) {
  const closed: Poll = {
    ...poll,
    status: "closed",
    closedAt: new Date().toISOString(),
    closedBy: by,
  };
  await savePoll(ctx, closed);
  if (by !== null && poll.taskId) await ctx.schedule.cancel(poll.taskId);
  const t = await tally(ctx, closed);
  await ctx.events.publish("closed", closedEvent(closed, t) as unknown as Json);
  ctx.log.info("poll closed", { poll: poll.id, voters: t.voters.length, by });
  return renderPoll(closed, t, ctx.config.color);
}

/** Records the voter's choice indexes and refreshes the poll message. */
async function vote(ctx: Context, interaction: ComponentInteraction, poll: Poll, picked: number[]) {
  const key = voteKey(poll.id, interaction.user.id);
  if (picked.length === 0) await ctx.kv.delete(key);
  else await ctx.kv.set(key, picked);
  await interaction.update(renderPoll(poll, await tally(ctx, poll), ctx.config.color));
  if (ctx.config.confirmVotes) {
    const labels = picked.map((i) => poll.choices[i]).join(", ");
    await interaction.followUp({
      content: labels ? `Your vote: **${labels}**` : "Your vote was removed.",
      ephemeral: true,
    });
  }
}

async function openPoll(
  interaction: ComponentInteraction,
  ctx: Context,
): Promise<Poll | undefined> {
  const id = interaction.componentId.split(":")[1] ?? "";
  const poll = await getPoll(ctx, id);
  if (!poll || poll.status !== "open") {
    if (poll) await interaction.update(renderPoll(poll, await tally(ctx, poll), ctx.config.color));
    else await interaction.reply({ content: "This poll no longer exists.", ephemeral: true });
    return undefined;
  }
  return poll;
}

/**
 * Poll managers: the managerRoles, and members with Administrator or ManageServer
 * (server-level permissions; missing on an older engine, then only managerRoles count).
 */
const isManager = (ctx: Context, member: Member | undefined): boolean =>
  member !== undefined &&
  (ctx.config.managerRoles.some((r) => member.hasRole(r)) ||
    (member.permissions ?? []).some((p) => p === "Administrator" || p === "ManageServer"));

const isRole = (target: User | Role): target is Role => !("username" in target);

/**
 * Who the `ping` option may notify, or why it is refused. Anyone may ping a member or a
 * mentionable role; only a manager may ping a role that is not mentionable (the bot could,
 * so the plugin must not do it for anyone). Exactly that member or role is allowed to be
 * notified, nobody else (not even the author's mention in the text). @everyone never pings.
 */
function pingMentions(
  ctx: Context,
  member: Member | undefined,
  ping: User | Role | undefined,
): { allowed: AllowedMentions } | { refused: string } {
  const none: AllowedMentions = { users: [], roles: [], everyone: false };
  if (!ping) return { allowed: none };
  if (!isRole(ping)) return { allowed: { ...none, users: [ping.id] } };
  const everyone = ping.id === ctx.server.id;
  if (!isManager(ctx, member) && (everyone || ping.mentionable !== true))
    return {
      refused: `You cannot ping ${everyone ? "@everyone" : `the role @${ping.name}`}: only poll managers may ping a role that is not mentionable.`,
    };
  return { allowed: everyone ? none : { ...none, roles: [ping.id] } };
}

/** Autocomplete of the `poll` option: open polls (`/polls close`) or every poll. */
function pollOption(onlyOpen: boolean) {
  return {
    type: "string",
    description: onlyOpen ? "Open poll (number or question)" : "Poll (number or question)",
    required: true,
    maxLength: 100,
    async autocomplete(ctx: Context, interaction: AutocompleteInteraction, focused: FocusedOption) {
      let polls = await listPolls(ctx);
      if (onlyOpen) {
        polls = polls.filter(
          (p) =>
            p.status === "open" &&
            (p.authorId === interaction.user.id || isManager(ctx, interaction.member)),
        );
      }
      return suggestPolls(polls, focused.value);
    },
  } as const;
}

/** "#12 Pizza night?" or "12" (what the user typed when not picking a suggestion). */
const pollId = (raw: string): string => /^#?(\d+)/.exec(raw.trim())?.[1] ?? "";

export default definePlugin({
  commands: {
    poll: command({
      description: "Start a poll",
      ephemeral: true,
      options: {
        question: { type: "string", description: "The question", required: true },
        choices: {
          type: "string",
          description: "Choices separated by | (2 to 10)",
          required: true,
        },
        hours: {
          type: "number",
          description: "How long it stays open, in hours (0.5 = 30 min)",
          min: 0.05,
          max: 720,
        },
        multiple: { type: "boolean", description: "Allow several choices" },
        style: {
          type: "string",
          description: "Buttons (default) or a select menu",
          choices: [
            { name: "Buttons", value: "buttons" },
            { name: "Select menu", value: "select" },
          ],
        },
        ping: { type: "mentionable", description: "Member or role to notify" },
        thread: { type: "boolean", description: "Open a discussion thread on the poll" },
      },
      async run(ctx, interaction) {
        const o = interaction.options;
        const channel = interaction.channel;
        if (!channel) {
          await interaction.reply("Polls can only be started in a server channel.");
          return;
        }
        const allowed = ctx.config.channels.map((key) => ctx.server.channel(key).id);
        if (allowed.length > 0 && !allowed.includes(channel.id)) {
          await interaction.reply(
            `Polls can be started in ${allowed.map((id) => `<#${id}>`).join(", ")}.`,
          );
          return;
        }
        const choices = parseChoices(o.choices);
        if (choices.length < 2 || choices.length > MAX_CHOICES) {
          await interaction.reply(
            `A poll needs 2 to ${MAX_CHOICES} different choices, separated by |.`,
          );
          return;
        }
        const ping = pingMentions(ctx, interaction.member, o.ping);
        if ("refused" in ping) {
          await interaction.reply({ content: ping.refused, ephemeral: true });
          return;
        }
        const hours = Math.min(o.hours ?? ctx.config.defaultHours, ctx.config.maxHours);
        const now = Date.now();
        const poll: Poll = {
          id: String(await ctx.kv.increment("seq")),
          question: o.question.slice(0, 200),
          choices,
          multiple: o.multiple ?? false,
          style: o.style === "select" ? "select" : "buttons",
          authorId: interaction.user.id,
          channelId: channel.id,
          messageId: "",
          createdAt: new Date(now).toISOString(),
          closesAt: new Date(now + hours * HOUR).toISOString(),
          status: "open",
        };
        const message = await channel.send({
          ...renderPoll(poll, { counts: choices.map(() => 0), voters: [] }, ctx.config.color),
          ...(o.ping
            ? { content: `${o.ping.mention} — new poll by ${interaction.user.mention}` }
            : {}),
          allowedMentions: ping.allowed,
        });
        poll.messageId = message.id;
        poll.taskId = (await ctx.schedule.after(hours * HOUR, "close", { id: poll.id })).id;
        await savePoll(ctx, poll);
        if (o.thread)
          await channel.createThread(`Poll: ${poll.question}`.slice(0, 100), {
            fromMessage: message.id,
          });
        await interaction.reply(`Poll #${poll.id} posted. It closes in ${hours} h.`);
      },
    }),

    /** `/polls close` and `/polls results`: subcommands whose `poll` option autocompletes. */
    polls: command({
      description: "Manage polls",
      ephemeral: true,
      subcommands: {
        close: subcommand({
          description: "Close a poll now (its author or a manager)",
          options: { poll: pollOption(true) },
          async run(ctx, interaction) {
            const poll = await getPoll(ctx, pollId(interaction.options.poll));
            if (!poll) {
              await interaction.reply("No such poll.");
              return;
            }
            if (poll.status !== "open") {
              await interaction.reply(`Poll #${poll.id} is already closed.`);
              return;
            }
            if (poll.authorId !== interaction.user.id && !isManager(ctx, interaction.member)) {
              await interaction.reply("Only the author of the poll can close it.");
              return;
            }
            const final = await closePoll(ctx, poll, interaction.user.id);
            const message = await findMessage(ctx, poll.channelId, poll.messageId);
            if (message) await message.edit(final);
            await interaction.reply(`Poll #${poll.id} is closed.`);
          },
        }),
        results: subcommand({
          description: "Show the current results of a poll",
          options: { poll: pollOption(false) },
          async run(ctx, interaction) {
            const poll = await getPoll(ctx, pollId(interaction.options.poll));
            if (!poll) {
              await interaction.reply("No such poll.");
              return;
            }
            const { embeds } = renderPoll(poll, await tally(ctx, poll), ctx.config.color);
            await interaction.reply(embeds ? { embeds } : {});
          },
        }),
      },
    }),
  },

  components: {
    /** Button `vote:<poll>:<choice>`: toggles the choice. */
    async vote(ctx, interaction) {
      const poll = await openPoll(interaction, ctx);
      if (!poll) return;
      const choice = Number(interaction.componentId.split(":")[2]);
      if (!Number.isInteger(choice) || choice < 0 || choice >= poll.choices.length) return;
      const current = (await ctx.kv.get<number[]>(voteKey(poll.id, interaction.user.id))) ?? [];
      const picked = current.includes(choice)
        ? current.filter((i) => i !== choice)
        : poll.multiple
          ? [...current, choice].toSorted((a, b) => a - b)
          : [choice];
      await vote(ctx, interaction, poll, picked);
    },

    /** Select menu `pick:<poll>`. */
    async pick(ctx, interaction) {
      const poll = await openPoll(interaction, ctx);
      if (!poll) return;
      const picked = [...new Set(interaction.values.map(Number))]
        .filter((i) => Number.isInteger(i) && i >= 0 && i < poll.choices.length)
        .slice(0, poll.multiple ? poll.choices.length : 1)
        .toSorted((a, b) => a - b);
      await vote(ctx, interaction, poll, picked);
    },

    /** Button `end:<poll>`: the author or a manager closes it now. */
    async end(ctx, interaction) {
      const poll = await openPoll(interaction, ctx);
      if (!poll) return;
      if (poll.authorId !== interaction.user.id && !isManager(ctx, interaction.member)) {
        await interaction.reply({
          content: "Only the author of the poll can close it.",
          ephemeral: true,
        });
        return;
      }
      await interaction.update(await closePoll(ctx, poll, interaction.user.id));
    },
  },

  tasks: {
    /** Scheduled when the poll is created; closes it unless it was closed manually. */
    async close(ctx, payload) {
      const id = (payload as { id?: string } | undefined)?.id ?? "";
      const poll = await getPoll(ctx, id);
      if (!poll || poll.status !== "open") return;
      const final = await closePoll(ctx, poll, null);
      const message = await findMessage(ctx, poll.channelId, poll.messageId);
      if (message) await message.edit(final);
      else await ctx.server.channel({ id: poll.channelId }).send(final);
    },
  },

  // Checked against the portal contract in routes.ts (copied into portals by `cicord portal typegen`).
  routes: defineRoutes<Routes>({
    /** Results of a poll (public: polls are posted in public channels). */
    "GET /polls/:id": {
      access: "public",
      async handler(ctx, request) {
        const poll = await getPoll(ctx, request.params.id);
        if (!poll)
          return { status: 404, body: { error: { code: "not_found", message: "no such poll" } } };
        const t = await tally(ctx, poll);
        return {
          id: poll.id,
          question: poll.question,
          status: poll.status,
          multiple: poll.multiple,
          createdAt: poll.createdAt,
          closesAt: poll.closesAt,
          closedAt: poll.closedAt ?? null,
          choices: poll.choices.map((label, i) => ({ label, votes: t.counts[i] ?? 0 })),
          voters: t.voters.length,
        };
      },
    },
  }),
});
