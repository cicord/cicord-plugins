import {
  InteropError,
  command,
  query,
  type MessagePayload,
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
  nativeTally,
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
import type { VotersInput } from "./contracts.ts";
import type { Routes } from "./routes.ts";

const HOUR = 3_600_000;

/** Closes a poll: final results, cancels the scheduled closing, publishes `polls.closed`. */
async function closePoll(ctx: Context, poll: Poll, by: string | null) {
  // Persist results before disclosure or erasure. A retry uses the same publication key.
  if (!poll.final && !poll.closing) {
    const key = "poll:" + poll.id,
      entry = await ctx.kv.getEntry(key);
    if (!entry) throw new Error("Poll no longer exists");
    const current = entry.value as unknown as Poll;
    if (current.status === "open") {
      const frozen: Poll = {
        ...current,
        status: "closed",
        closing: true,
        closedAt: new Date().toISOString(),
        closedBy: by,
      };
      const claimed = await ctx.kv
        .atomic()
        .check(key, entry.version)
        .set(key, frozen as unknown as Json)
        .commit();
      if (!claimed.ok) throw new Error("Poll closure changed; retry");
      poll = frozen;
    } else poll = current;
  }
  if (!poll.final) {
    const native =
      poll.style === "native" ? await findMessage(ctx, poll.channelId, poll.messageId) : undefined;
    if (poll.style === "native" && !native?.poll) throw new Error("Discord poll is unavailable");
    const result = native && !native.poll?.finalized ? await native.endPoll() : native;
    const t = result ? await nativeTally(result, true) : await tally(ctx, poll);
    if (result) {
      for (let offset = 0; offset < t.voters.length; offset += 1000)
        await ctx.kv.set(`native:${poll.id}:${offset}`, t.voters.slice(offset, offset + 1000));
    }
    poll = {
      ...poll,
      status: "closed",
      closing: false,
      final: { counts: t.counts, voterCount: t.voterCount ?? t.voters.length },
    };
    await savePoll(ctx, poll);
  }
  const t = { ...poll.final!, voters: [] as string[] };
  if (!poll.published) {
    if (poll.anonymous) {
      let cursor: string | undefined;
      do {
        const page = await ctx.kv.list({ prefix: `vote:${poll.id}:`, limit: 50, cursor });
        if (page.items.length) {
          const batch = ctx.kv.atomic();
          for (const { key } of page.items) batch.delete(key);
          await batch.commit();
        }
        cursor = page.cursor;
      } while (cursor);
    } else if (t.voterCount <= 10000) {
      let cursor: string | undefined;
      do {
        const page = await voterPage(ctx, poll, cursor);
        t.voters.push(...page.userIds);
        cursor = page.cursor;
      } while (cursor);
    }
    const legacy = closedEvent(poll, t);
    const { voters, ...summary } = legacy;
    const modern = {
      ...summary,
      voterCount: t.voterCount,
      ...(!poll.anonymous && t.voterCount > 10000 ? { votersTruncated: true } : { voters }),
    };
    await ctx.events.publish("closed", legacy, {
      version: 1,
      idempotencyKey: `close:${poll.id}:v1`,
    });
    await ctx.events.publish("closed", modern, {
      version: 2,
      idempotencyKey: `close:${poll.id}:v2`,
    });
    await savePoll(ctx, { ...poll, published: true });
  }
  if (by !== null && poll.taskId) await ctx.schedule.cancel(poll.taskId);
  return renderPoll(poll, t, ctx);
}

async function voterPage(
  ctx: Context,
  poll: Poll,
  cursor?: string,
): Promise<{ userIds: string[]; cursor?: string }> {
  if (poll.anonymous || poll.status !== "closed") return { userIds: [] };
  if (poll.style === "native") {
    const n = Number(cursor ?? 0);
    if (!Number.isSafeInteger(n) || n < 0 || n % 1000 !== 0)
      throw new Error("invalid voter cursor");
    const userIds = (await ctx.kv.get<string[]>(`native:${poll.id}:${n}`)) ?? [];
    return {
      userIds,
      ...(n + 1000 < (poll.final?.voterCount ?? 0) ? { cursor: String(n + 1000) } : {}),
    };
  }
  const prefix = `vote:${poll.id}:`;
  if (cursor && !cursor.startsWith(prefix)) throw new Error("invalid voter cursor");
  const page = await ctx.kv.list({ prefix, cursor, limit: 1000 });
  return {
    userIds: page.items.map((x) => x.key.slice(prefix.length)),
    ...(page.cursor ? { cursor: page.cursor } : {}),
  };
}

function pollPayload(poll: Poll, ctx: Context): MessagePayload {
  return poll.style === "native"
    ? {
        poll: {
          question: poll.question,
          answers: poll.choices.map((text) => ({ text })),
          durationHours: poll.hours!,
          multiselect: poll.multiple,
        },
      }
    : renderPoll(poll, { counts: poll.choices.map(() => 0), voters: [] }, ctx);
}

/** Records the voter's choice indexes and refreshes the poll message. */
async function vote(ctx: Context, interaction: ComponentInteraction, poll: Poll, picked: number[]) {
  if (poll.style === "native") return;
  if (
    poll.eligibleRoles?.length &&
    !poll.eligibleRoles.some((role) => interaction.member?.hasRole(role))
  ) {
    await interaction.reply({ content: ctx.i18n.t("ineligible"), ephemeral: true });
    return;
  }
  if (picked.length > (poll.maxChoices ?? poll.choices.length)) {
    await interaction.reply({
      content: ctx.i18n.t("limit", { max: poll.maxChoices! }),
      ephemeral: true,
    });
    return;
  }
  const weight = Math.max(
    1,
    ...(poll.weights ?? []).filter((w) => interaction.member?.hasRole(w.role)).map((w) => w.weight),
  );
  const key = voteKey(poll.id, interaction.user.id);
  const pollKey = "poll:" + poll.id,
    state = await ctx.kv.getEntry(pollKey);
  if (!state || (state.value as unknown as Poll).status !== "open") {
    await interaction.reply({ content: ctx.i18n.t("votingClosed"), ephemeral: true });
    return;
  }
  const batch = ctx.kv.atomic().check(pollKey, state.version);
  if (!picked.length) batch.delete(key);
  else batch.set(key, weight === 1 ? picked : { choices: picked, weight });
  if (!(await batch.commit()).ok) {
    await interaction.reply({ content: ctx.i18n.t("votingClosed"), ephemeral: true });
    return;
  }
  await interaction.update(renderPoll(poll, await tally(ctx, poll), ctx));
  if (ctx.config.confirmVotes) {
    const labels = picked.map((i) => poll.choices[i]).join(", ");
    await interaction.followUp({
      content: labels ? ctx.i18n.t("confirmation", { labels }) : ctx.i18n.t("removed"),
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
  if (poll && !canRead(poll, interaction.member)) {
    await interaction.reply({ content: ctx.i18n.t("gone"), ephemeral: true });
    return undefined;
  }
  if (!poll || poll.status !== "open") {
    if (poll) await interaction.update(renderPoll(poll, await tally(ctx, poll), ctx));
    else await interaction.reply({ content: ctx.i18n.t("gone"), ephemeral: true });
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
      refused: ctx.i18n.t("pingRefused", {
        target: everyone ? "@everyone" : ctx.i18n.t("role", { name: ping.name }),
      }),
    };
  return { allowed: everyone ? none : { ...none, roles: [ping.id] } };
}

function canRead(poll: Poll, member: Member | undefined): boolean {
  return member?.canView({ id: poll.channelId }) ?? false;
}

/** Autocomplete of the `poll` option: open polls (`/polls close`) or every poll. */
function pollOption(onlyOpen: boolean) {
  return {
    type: "string",
    description: onlyOpen ? "Open poll (number or question)" : "Poll (number or question)",
    required: true,
    maxLength: 100,
    async autocomplete(ctx: Context, interaction: AutocompleteInteraction, focused: FocusedOption) {
      const member = await ctx.server.member(interaction.user.id);
      if (!member) return [];
      let polls = (await listPolls(ctx)).filter((p) => canRead(p, member));
      if (onlyOpen) {
        polls = polls.filter(
          (p) =>
            p.status === "open" && (p.authorId === interaction.user.id || isManager(ctx, member)),
        );
      }
      return suggestPolls(polls, focused.value);
    },
  } as const;
}

/** "#12 Pizza night?" or "12" (what the user typed when not picking a suggestion). */
const pollId = (raw: string): string => /^#?(\d+)/.exec(raw.trim())?.[1] ?? "";

async function privatePollData(ctx: Context, id: string, erase: boolean) {
  const rows: Json[] = [];
  for (const p of await listPolls(ctx)) {
    const key = voteKey(p.id, id),
      vote = await ctx.kv.get(key);
    if (vote !== undefined) {
      if (!p.anonymous) rows.push({ pollId: p.id, vote });
      else if (erase) rows.push({ pollId: p.id });
      if (erase) await ctx.kv.delete(key);
    }
    if (p.authorId === id || p.closedBy === id) {
      rows.push({ pollId: p.id, author: p.authorId === id, closer: p.closedBy === id });
      if (erase) {
        if (p.authorId === id) p.authorId = "";
        if (p.closedBy === id) p.closedBy = null;
        await savePoll(ctx, p);
      }
    }
    if (p.style === "native" && p.final) {
      for (let n = 0; n < p.final.voterCount; n += 1000) {
        const k = `native:${p.id}:${n}`,
          ids = await ctx.kv.get<string[]>(k);
        if (ids?.includes(id)) {
          rows.push({ pollId: p.id, voter: true });
          if (erase)
            await ctx.kv.set(
              k,
              ids.filter((x) => x !== id),
            );
        }
      }
    }
  }
  return rows;
}
export default definePlugin({
  /** KV layout version (§6). 1: the 0.1.1 layout, read in place (legacy array ballots too). */
  async onStart(ctx) {
    await ctx.kv.set("meta:schema", 1);
  },
  privacy: {
    export: (ctx, id) => privatePollData(ctx, id, false),
    async erase(ctx, id) {
      return { erased: (await privatePollData(ctx, id, true)).length };
    },
  },
  queries: {
    voters: query({
      async run(ctx, input: VotersInput, call) {
        if (
          input.publisher &&
          (input.publisher.bot !== ctx.bot.key || input.publisher.instance !== ctx.plugin.instance)
        )
          throw new InteropError(
            "not_found",
            "The event originated at another polls installation.",
          );
        if (call.onBehalfOf?.access === "scoped")
          throw new InteropError("denied", "A case-scoped session cannot read ballots.");
        const p = await getPoll(ctx, input.pollId);
        if (!p || p.anonymous) return { userIds: [] };
        if (call.onBehalfOf) {
          const member = await ctx.server.member(call.onBehalfOf.userId);
          if (!member?.canView({ id: p.channelId }))
            throw new InteropError("denied", "The member cannot read the poll channel.");
        }
        return voterPage(ctx, p, input.cursor);
      },
    }),
  },
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
          max: 768,
        },
        anonymous: {
          type: "boolean",
          description: "Keep voter identities private (buttons and select only)",
        },
        maximum: { type: "integer", description: "Maximum selections per voter", min: 1, max: 10 },
        start: { type: "string", description: "Schedule a future start (ISO 8601 date and time)" },
        multiple: { type: "boolean", description: "Allow several choices" },
        style: {
          type: "string",
          description: "Buttons (default) or a select menu",
          choices: [
            { name: "Buttons", value: "buttons" },
            { name: "Select menu", value: "select" },
            { name: "Discord poll", value: "native" },
          ],
        },
        ping: { type: "mentionable", description: "Member or role to notify" },
        thread: { type: "boolean", description: "Open a discussion thread on the poll" },
      },
      async run(ctx, interaction) {
        const o = interaction.options;
        const channel = interaction.channel;
        if (!channel) {
          await interaction.reply(ctx.i18n.t("serverOnly"));
          return;
        }
        const allowed = ctx.config.channels.map((key) => ctx.server.channel(key).id);
        if (allowed.length > 0 && !allowed.includes(channel.id)) {
          await interaction.reply(
            ctx.i18n.t("allowed", { channels: allowed.map((id) => `<#${id}>`).join(", ") }),
          );
          return;
        }
        const choices = parseChoices(o.choices);
        if (choices.length < 2 || choices.length > MAX_CHOICES) {
          await interaction.reply(ctx.i18n.t("choiceCount", { max: MAX_CHOICES }));
          return;
        }
        const ping = pingMentions(ctx, interaction.member, o.ping);
        if ("refused" in ping) {
          await interaction.reply({ content: ping.refused, ephemeral: true });
          return;
        }
        const requested = o.hours ?? ctx.config.defaultHours;
        const native = o.style === "native";
        if (
          native &&
          (o.anonymous ||
            o.maximum !== undefined ||
            ctx.config.eligibleRoles.length ||
            ctx.config.roleWeights.length ||
            !Number.isInteger(requested) ||
            requested < 1 ||
            requested > 768 ||
            requested > ctx.config.maxHours ||
            choices.some((c) => c.length > 55))
        ) {
          await interaction.reply(ctx.i18n.t("nativeOptions"));
          return;
        }
        const start = o.start ? Date.parse(o.start) : Date.now();
        if (o.start && (!Number.isFinite(start) || start <= Date.now())) {
          await interaction.reply(ctx.i18n.t("future"));
          return;
        }
        // Optional feature: refuse before anything is posted, never leave a half-made poll.
        if (o.thread && !ctx.features.enabled("discussionThread")) {
          await interaction.reply(ctx.i18n.t("threadUnavailable"));
          return;
        }
        if (o.start && (o.ping || o.thread)) {
          await interaction.reply(ctx.i18n.t("scheduledOptions"));
          return;
        }
        const hours = Math.min(requested, ctx.config.maxHours);
        const now = Date.now();
        const poll: Poll = {
          id: String(await ctx.kv.increment("seq")),
          question: o.question.slice(0, 200),
          choices,
          multiple: o.multiple ?? false,
          style: native ? "native" : o.style === "select" ? "select" : "buttons",
          anonymous: o.anonymous ?? false,
          hours,
          eligibleRoles: ctx.config.eligibleRoles,
          weights: ctx.config.roleWeights,
          ...(o.maximum ? { maxChoices: o.maximum, multiple: o.maximum > 1 } : {}),
          authorId: interaction.user.id,
          channelId: channel.id,
          messageId: "",
          createdAt: new Date(now).toISOString(),
          closesAt: new Date(start + hours * HOUR).toISOString(),
          status: "open",
        };
        if (o.start) {
          poll.status = "scheduled";
          await savePoll(ctx, poll);
          await ctx.schedule.after(start - now, "open", { id: poll.id });
          await interaction.reply(ctx.i18n.t("scheduled", { id: poll.id }));
          return;
        }
        const message = await channel.send({
          ...pollPayload(poll, ctx),
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
        await interaction.reply(ctx.i18n.t("posted", { id: poll.id, hours }));
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
            if (!poll || !canRead(poll, interaction.member)) {
              await interaction.reply(ctx.i18n.t("unknown"));
              return;
            }
            if (poll.status !== "open") {
              await interaction.reply(ctx.i18n.t("alreadyClosed", { id: poll.id }));
              return;
            }
            if (poll.authorId !== interaction.user.id && !isManager(ctx, interaction.member)) {
              await interaction.reply(ctx.i18n.t("authorOnly"));
              return;
            }
            const final = await closePoll(ctx, poll, interaction.user.id);
            if (poll.style !== "native") {
              const message = await findMessage(ctx, poll.channelId, poll.messageId);
              if (message) await message.edit(final);
            }
            await interaction.reply(ctx.i18n.t("closed", { id: poll.id }));
          },
        }),
        results: subcommand({
          description: "Show the current results of a poll",
          options: { poll: pollOption(false) },
          async run(ctx, interaction) {
            const poll = await getPoll(ctx, pollId(interaction.options.poll));
            if (!poll || !canRead(poll, interaction.member)) {
              await interaction.reply(ctx.i18n.t("unknown"));
              return;
            }
            const { embeds } = renderPoll(poll, await tally(ctx, poll), ctx);
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
      const ballot = await ctx.kv.get<number[] | { choices: number[]; weight: number }>(
        voteKey(poll.id, interaction.user.id),
      );
      const current = Array.isArray(ballot) ? ballot : (ballot?.choices ?? []);
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
          content: ctx.i18n.t("authorOnly"),
          ephemeral: true,
        });
        return;
      }
      await interaction.update(await closePoll(ctx, poll, interaction.user.id));
    },
  },

  tasks: {
    async open(ctx, payload) {
      const poll = await getPoll(ctx, (payload as { id: string }).id);
      if (!poll || poll.status !== "scheduled") return;
      const channel = ctx.server.channel({ id: poll.channelId });
      const marker = `Poll #${poll.id} · ${ctx.plugin.instance}`;
      const history = await channel.messages({ limit: 100 });
      const msg =
        history.find((m) => m.author.id === ctx.bot.user.id && m.content === marker) ??
        (await channel.send({
          ...pollPayload(poll, ctx),
          content: marker,
          allowedMentions: { users: [], roles: [], everyone: false },
        }));
      poll.messageId = msg.id;
      poll.status = "open";
      poll.taskId = (
        await ctx.schedule.after(Math.max(1, Date.parse(poll.closesAt) - Date.now()), "close", {
          id: poll.id,
        })
      ).id;
      await savePoll(ctx, poll);
    },
    /** Scheduled when the poll is created; closes it unless it was closed manually. */
    async close(ctx, payload) {
      const id = (payload as { id?: string } | undefined)?.id ?? "";
      const poll = await getPoll(ctx, id);
      if (
        !poll ||
        poll.status === "scheduled" ||
        (poll.status === "closed" && (poll.published || (!poll.final && !poll.closing)))
      )
        return;
      const final = await closePoll(ctx, poll, null);
      if (poll.style === "native") return;
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
        if (
          !poll ||
          (request.viewer
            ? !canRead(poll, request.viewer.member)
            : !ctx.server.audience({ id: poll.channelId }).public)
        )
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
          voters: t.voterCount ?? t.voters.length,
        };
      },
    },
  }),
});
