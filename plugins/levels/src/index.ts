import {
  action,
  command,
  query,
  subcommand,
  type Json,
  definePlugin,
  defineRoutes,
  type Context,
  type Member,
  type Message,
} from "@cicord/sdk";
import {
  authorKey,
  bar,
  cooldownKey,
  dayOf,
  leaderboard,
  levelOf,
  leaders,
  position,
  progress,
  render,
  saveProfile,
  standings,
} from "./levels.ts";
import {
  credit,
  migrate,
  personal,
  seasonBatch,
  importCsv,
  ConcurrentReaction,
  type ReactionChange,
} from "./storage.ts";
import type { GrantXp } from "./contracts.ts";
import type { Routes } from "./routes.ts";

const WEEK = 7 * 24 * 3600;

interface AwardContext {
  /** Message that earned the XP (announce by replying to it, react 🎉). */
  message?: Message;
  member?: Member;
}

/** Adds XP (negative to take it back) and handles level-ups. Returns the new total. */
async function award(
  ctx: Context,
  userId: string,
  amount: number,
  from: AwardContext = {},
  id: string = crypto.randomUUID(),
  absolute = false,
  reaction?: ReactionChange,
): Promise<number> {
  const { xp, previous, level } = await credit(ctx, userId, amount, id, absolute, reaction);
  if (level > previous) {
    if (ctx.features.enabled("levelEvents"))
      await ctx.events.publish(
        "levelUp",
        { userId, level, previous, xp },
        { idempotencyKey: id + ":" + userId },
      );
    // A role transition may be reconciled repeatedly; send at most one public celebration per award.
    const notice = "notice:" + userId + ":" + id;
    if (
      (
        await ctx.kv
          .atomic()
          .check(notice, null)
          .set(notice, true, { ttlSeconds: 30 * 86400 })
          .commit()
      ).ok
    )
      await levelUp(ctx, userId, level, from);
  }
  return xp;
}

async function levelUp(ctx: Context, userId: string, level: number, from: AwardContext) {
  ctx.log.info("level up", { member: userId, level });
  const member = from.member ?? (await ctx.server.member(userId));
  if (member) await applyRewards(ctx, member, level);

  const template =
    ctx.config.announce.message === "GG {member}, you reached **level {level}**! 🎉"
      ? tr(ctx, "announcement")
      : ctx.config.announce.message;
  const text = render(template, {
    member: `<@${userId}>`,
    level: String(level),
  });
  // The message may be gone (deleted by a moderator or another plugin): never fail the XP.
  try {
    let posted: Message | undefined;
    if (ctx.config.announce.channel) {
      posted = await ctx.server
        .channel(ctx.config.announce.channel)
        .send({ content: text, allowedMentions: { users: true } });
    } else if (from.message) {
      posted = await from.message.reply({ content: text, allowedMentions: { users: true } });
    }
    if (posted?.author.id === ctx.bot.user.id)
      await ctx.kv.set("copy:" + userId + ":" + posted.id, {
        channelId: posted.channel.id,
        messageId: posted.id,
        kind: "level",
      });
    if (ctx.config.announce.react && from.message) await from.message.react("🎉");
  } catch (error) {
    ctx.log.warn("levels: level-up announcement failed", { member: userId, error: String(error) });
  }
}

/** Reward roles for a level: reached rewards are given; lower ones without `keep` removed. */
async function applyRewards(ctx: Context, member: Member, level: number) {
  const reached = ctx.config.rewards.filter((r) => r.level <= level);
  const highest = Math.max(0, ...reached.map((r) => r.level));
  for (const r of reached) {
    const wanted =
      ctx.config.rewardMode === "stack" ||
      (ctx.config.rewardMode === "configured" && r.keep) ||
      r.level === highest;
    try {
      if (wanted && !member.hasRole(r.role)) await member.addRole(r.role, `levels: level ${level}`);
      else if (!wanted && member.hasRole(r.role))
        await member.removeRole(r.role, `levels: level ${level}`);
    } catch (error) {
      ctx.log.warn("levels: role reward failed", {
        member: member.id,
        role: r.role,
        error: String(error),
      });
    }
  }
}

const tr = (ctx: Context, key: string, vars: Record<string, string | number> = {}) =>
  ctx.i18n.t(key, vars);
function rankCard(ctx: Context, name: string, xp: number, rank: number, of: number) {
  const p = progress(xp);
  return [
    tr(ctx, "rank", {
      name,
      level: p.level,
      xp,
      rank: rank ? tr(ctx, "place", { rank, count: of }) : "",
    }),
    tr(ctx, "next", { bar: bar(p), current: p.current, needed: p.needed, level: p.level + 1 }),
  ].join("\n");
}
function multiplier(ctx: Context, m: Member, channel: string) {
  if (ctx.config.noXpRoles.some((r) => m.hasRole(r))) return 0;
  const roles = ctx.config.roleMultipliers.filter((r) => m.hasRole(r.role)).map((r) => r.factor);
  const c = ctx.config.channelMultipliers.find((r) => ctx.server.channel(r.channel).id === channel);
  const date = Date.now(),
    boost = ctx.config.boosts
      .filter((b) => Date.parse(b.start) <= date && date < Date.parse(b.end))
      .reduce((v, b) => v * b.factor, 1);
  return (roles.length ? Math.max(...roles) : 1) * (c?.factor ?? 1) * boost;
}
const adminXp = (mode: "give" | "remove" | "set" | "reset") =>
  subcommand({
    description: mode + " member XP",
    options: {
      member: { type: "user", required: true, description: "Member" },
      amount: {
        type: "integer",
        description: "XP amount",
        min: 0,
        max: 1000000000,
        required: mode !== "reset",
      },
    },
    async run(ctx, i) {
      if (
        !ctx.config.enabled ||
        !i.member?.permissions?.some((p) => p === "ManageServer" || p === "Administrator")
      )
        return i.reply(tr(ctx, "denied"));
      if (mode === "reset")
        return i.reply({
          content: tr(ctx, "confirmation"),
          components: [
            {
              type: "row",
              components: [
                {
                  type: "button",
                  id: "reset:" + i.user.id + ":" + i.options.member.id,
                  label: tr(ctx, "reset"),
                  style: "danger",
                },
              ],
            },
          ],
        });
      const xp = await award(
        ctx,
        i.options.member.id,
        (mode === "remove" ? -1 : 1) * (i.options.amount ?? 0),
        {},
        i.id,
        mode === "set",
      );
      await i.reply(tr(ctx, "updated", { xp }));
    },
  });
async function batch(ctx: Context, ids: string[], xp: number, origin: string) {
  for (let i = 0; i < ids.length; i += 25) {
    const slice = ids.slice(i, i + 25);
    if (ids.length <= 25) await voters(ctx, slice, xp, origin);
    else await ctx.schedule.after(1, "voter-batch", { ids: slice, xp, origin });
  }
}
async function voters(ctx: Context, ids: string[], xp: number, origin: string) {
  for (const uid of new Set(ids)) {
    if (typeof uid !== "string") continue;
    // Populate public profiles lazily for bulk deliveries. Single legacy votes retain their profile.
    if (ids.length <= 2 || ctx.config.noXpRoles.length) {
      const m = await ctx.server.member(uid);
      if (ctx.config.noXpRoles.length && (!m || ctx.config.noXpRoles.some((r) => m.hasRole(r))))
        continue;
      if (m) await saveProfile(ctx, m.user, m.displayName);
    }
    await award(ctx, uid, xp, {}, origin);
  }
}
async function reaction(
  ctx: Context,
  message: Message,
  reactor: string,
  emoji: string,
  adding: boolean,
) {
  if (!ctx.config.enabled || !ctx.config.reactionXp) return;
  const author = await ctx.kv.get<string>(authorKey(message.id));
  if (!author || author === reactor) return;
  const key = "reaction:" + message.id + ":" + reactor;
  const member = await ctx.server.member(author);
  const amount = member
    ? Math.round(ctx.config.reactionXp * multiplier(ctx, member, message.channel.id))
    : ctx.config.noXpRoles.length
      ? 0
      : ctx.config.reactionXp;
  for (;;) {
    const old = await ctx.kv.getEntry<{ emojis: string[]; amount: number }>(key);
    let emojis = old?.value.emojis;
    if (!emojis) {
      const prefix = "react:" + message.id + ":" + reactor + ":";
      emojis = (await ctx.kv.list({ prefix, limit: 100 })).items.map((item) =>
        item.key.slice(prefix.length),
      );
    }
    if (emojis.includes(emoji) === adding) return;
    const next = adding ? [...emojis, emoji] : emojis.filter((e) => e !== emoji);
    const before = emojis.length ? (old?.value.amount ?? ctx.config.reactionXp) : 0;
    const after = next.length ? (emojis.length ? before : amount) : 0;
    const change = { key, version: old?.version ?? null, value: { emojis: next, amount: after } };
    try {
      await award(
        ctx,
        author,
        after - before,
        member ? { member } : {},
        crypto.randomUUID(),
        false,
        change,
      );
      return;
    } catch (error) {
      if (!(error instanceof ConcurrentReaction)) throw error;
    }
  }
}
const bonus =
  (field: "approved" | "attended" | "starred" | "roomClosed", target: string) =>
  async (ctx: Context, p: Json, meta?: { id: string }) => {
    if (!ctx.config.enabled || !ctx.config.bonuses[field] || !ctx.features.enabled("pollBonus"))
      return;
    const e = p as Record<string, Json>;
    if (field === "approved" && e.status !== "approved") return;
    const ids = e[target];
    if (!meta?.id) throw new Error("Missing event receipt");
    await batch(
      ctx,
      Array.isArray(ids)
        ? ids.filter((s): s is string => typeof s === "string")
        : typeof ids === "string"
          ? [ids]
          : [],
      ctx.config.bonuses[field],
      meta.id,
    );
  };
export default definePlugin({
  async onStart(ctx) {
    if (!ctx.config.enabled) return;
    if ((await ctx.kv.get("meta:schema")) !== 2) await ctx.schedule.after(1, "migrate-ranking");
    if (ctx.config.importFile && ctx.features.enabled("importCsv"))
      await ctx.schedule.after(1, "import-csv");
    if (ctx.config.season?.end)
      await ctx.schedule.after(
        Math.max(1, Date.parse(ctx.config.season.end) - Date.now()),
        "season",
      );
  },
  tasks: {
    "migrate-ranking": migrate,
    "import-csv": importCsv,
    season: seasonBatch,
    async "voter-batch"(ctx, p) {
      if (!ctx.config.enabled) return;
      const v = p as { ids: string[]; xp: number; origin: string };
      await voters(ctx, v.ids, v.xp, v.origin);
    },
    async "voter-page"(ctx, p) {
      if (!ctx.config.enabled) return;
      const v = p as { pollId: string; cursor?: string; xp: number; origin: string };
      const r = (await ctx.plugins.query("polls", "voters", {
        pollId: v.pollId,
        ...(v.cursor ? { cursor: v.cursor } : {}),
      })) as { userIds: string[]; cursor?: string };
      await batch(ctx, r.userIds, v.xp, v.origin);
      if (r.cursor) await ctx.schedule.after(1, "voter-page", { ...v, cursor: r.cursor });
    },
    async "voice-minute"(ctx, p) {
      const { uid, channel, token, tick } = p as {
        uid: string;
        channel: string;
        token: string;
        tick: number;
      };
      if (!ctx.config.enabled || !ctx.config.voice.xpPerMinute) return;
      if ((await ctx.kv.get("voice:" + uid)) !== token) return;
      const members = (await ctx.server.voiceMembers({ id: channel })).filter((m) => !m.user.bot);
      const m = members.find((m) => m.id === uid);
      if (!m) return;
      const active = "voice-room:" + channel;
      if (members.length < 2) await ctx.kv.delete(active);
      const since = await ctx.kv.get<number>(active);
      if (members.length > 1 && since === undefined)
        await ctx.kv.atomic().check(active, null).set(active, Date.now()).commit();
      if (members.length > 1 && since !== undefined && Date.now() - since >= 60000)
        await award(
          ctx,
          uid,
          Math.round(ctx.config.voice.xpPerMinute * multiplier(ctx, m, channel)),
          { member: m },
          token + ":" + tick,
        );
      const delay =
        since === undefined ? 60000 : Math.max(1, Math.min(60000, since + 60000 - Date.now()));
      await ctx.schedule.after(
        since !== undefined && Date.now() - since < 60000 ? delay : 60000,
        "voice-minute",
        {
          uid,
          channel,
          token,
          tick: Math.max(tick + 1, Math.floor(Date.now() / 60000)),
        },
      );
    },
  },
  queries: {
    memberLevel: query({
      async run(ctx, input: { userId: string }) {
        if (!ctx.config.enabled) return { xp: 0, level: 0, rank: null };
        const p = await position(ctx, input.userId);
        return { xp: p.xp, level: levelOf(p.xp), rank: p.rank };
      },
    }),
    leaderboard: query({
      async run(ctx, input: { limit?: number; offset?: number }) {
        return {
          entries: ctx.config.enabled
            ? await leaderboard(ctx, input.limit ?? 25, input.offset ?? 0)
            : [],
        };
      },
    }),
  },
  actions: {
    grantXp: action({
      async run(ctx, input: GrantXp, call) {
        if (!ctx.config.enabled) throw new Error("Levels disabled");
        return { xp: await award(ctx, input.userId, input.amount, {}, call.idempotencyKey) };
      },
    }),
  },
  privacy: {
    export: (ctx, id) => personal(ctx, id, false),
    async erase(ctx, id) {
      return { erased: (await personal(ctx, id, true)).length };
    },
  },
  components: {
    async reset(ctx, i) {
      const [, by, uid] = i.componentId.split(":");
      if (
        !ctx.config.enabled ||
        !uid ||
        by !== i.user.id ||
        !i.member?.permissions?.some((p) => p === "ManageServer" || p === "Administrator")
      )
        return i.reply(tr(ctx, "denied"));
      await award(ctx, uid, 0, {}, i.id, true);
      await i.update({ content: tr(ctx, "updated", { xp: 0 }), components: [] });
    },
  },
  events: {
    async voiceStateUpdate(ctx, v) {
      if (
        !ctx.config.enabled ||
        !ctx.config.voice.xpPerMinute ||
        !ctx.features.enabled("voiceXp") ||
        v.user.bot
      )
        return;
      for (const id of new Set([v.previous?.id, v.channel?.id]))
        if (id) {
          const people = (await ctx.server.voiceMembers({ id })).filter(
            (person) => !person.user.bot,
          );
          const k = "voice-room:" + id;
          if (people.length < 2) await ctx.kv.delete(k);
          else await ctx.kv.atomic().check(k, null).set(k, Date.now()).commit();
        }
      if (
        !v.channel ||
        (v.selfDeaf && ctx.config.voice.requireUndeafened) ||
        ctx.server.afkChannelId === v.channel.id ||
        (ctx.config.voice.afkChannel &&
          ctx.server.channel(ctx.config.voice.afkChannel).id === v.channel.id)
      ) {
        await ctx.kv.delete("voice:" + v.user.id);
        return;
      }
      const current = await ctx.kv.get<string>("voice:" + v.user.id);
      if (current?.startsWith(v.channel.id + ":")) return;
      const token = v.channel.id + ":" + crypto.randomUUID();
      await ctx.kv.set("voice:" + v.user.id, token);
      await ctx.schedule.after(60000, "voice-minute", {
        uid: v.user.id,
        channel: v.channel.id,
        token,
        tick: Math.floor(Date.now() / 60000) + 1,
      });
    },
    async messageCreate(ctx, message) {
      if (!ctx.config.enabled || message.author.bot || !message.member) return;
      if (
        ctx.config.ignoredChannels.some((key) => ctx.server.channel(key).id === message.channel.id)
      )
        return;
      if (message.content.trim().length < ctx.config.minLength) return;
      const userId = message.author.id;
      // Remember the author for reactions (the reaction events only carry the message id).
      if (ctx.config.reactionXp > 0)
        await ctx.kv.set(authorKey(message.id), userId, { ttlSeconds: WEEK });
      const scale = multiplier(ctx, message.member, message.channel.id);
      if (!scale) return;
      if (await ctx.kv.get(cooldownKey(userId))) return;
      if (ctx.config.cooldownSeconds > 0)
        if (
          !(
            await ctx.kv
              .atomic()
              .check(cooldownKey(userId), null)
              .set(cooldownKey(userId), true, { ttlSeconds: ctx.config.cooldownSeconds })
              .commit()
          ).ok
        )
          return;
      await saveProfile(ctx, message.author, message.member.displayName);
      await award(
        ctx,
        userId,
        Math.round(ctx.config.xpPerMessage * scale),
        { message, member: message.member },
        "msg:" + message.id,
      );
    },

    /** `reaction.message` is partial (id + channel): the author comes from our own records. */
    async reactionAdd(ctx, { message, user, emoji }) {
      if (!user.bot) await reaction(ctx, message, user.id, emoji, true);
    },
    async reactionRemove(ctx, { message, user, emoji }) {
      if (!user.bot) await reaction(ctx, message, user.id, emoji, false);
    },
  },

  commands: {
    xp: command({
      description: "Manage member XP",
      ephemeral: true,
      permissions: ["ManageServer"],
      subcommands: {
        give: adminXp("give"),
        remove: adminXp("remove"),
        set: adminXp("set"),
        reset: adminXp("reset"),
      },
    }),
    rank: command({
      description: "Your level and XP (or another member's)",
      ephemeral: true,
      options: { member: { type: "user", description: "Member to look up" } },
      async run(ctx, interaction) {
        const target = interaction.options.member ?? interaction.user;
        if (!ctx.config.enabled) return interaction.reply(tr(ctx, "off"));
        const { xp, rank, count } = await position(ctx, target.id);
        const name =
          target.id === interaction.user.id
            ? (interaction.member?.displayName ?? target.displayName)
            : target.displayName;
        const url = await ctx.portal.link("/leaderboard", {
          member: interaction.member ?? interaction.user,
        });
        // No `ephemeral` here: the command's `ephemeral: true` is the default.
        let files;
        if (ctx.config.rankCard.enabled && ctx.features.enabled("rankCard")) {
          const p = progress(xp),
            theme = ctx.config.rankCard;
          const photo = await ctx.render.image({
            width: 550,
            height: 150,
            background: theme.asset ? { asset: theme.asset } : theme.background,
            layers: [
              {
                type: "text",
                x: 24,
                y: 40,
                size: 28,
                color: theme.foreground,
                text: name,
                maxWidth: 500,
                ellipsis: true,
              },
              {
                type: "text",
                x: 24,
                y: 82,
                size: 22,
                color: theme.foreground,
                text: xp + " XP · #" + (rank ?? "—"),
              },
              {
                type: "progress",
                x: 24,
                y: 110,
                width: 500,
                height: 12,
                color: theme.foreground,
                value: p.current / p.needed,
              },
            ],
          });
          files = [{ name: "rank.png", ...photo }];
        }
        await interaction.reply({
          ...(files ? { files } : {}),
          content: xp > 0 ? rankCard(ctx, name, xp, rank ?? 0, count) : tr(ctx, "none", { name }),
          components: [
            {
              type: "row",
              components: [{ type: "link", label: tr(ctx, "leaderboard"), emoji: "🏆", url }],
            },
          ],
        });
      },
    }),

    top: command({
      description: "The most active members",
      options: {
        limit: { type: "integer", description: "How many (1-25, default 10)", min: 1, max: 25 },
        role: { type: "role", description: "Only members with this role" },
      },
      async run(ctx, interaction) {
        const limit = interaction.options.limit ?? 10;
        const role = interaction.options.role;
        if (!ctx.config.enabled) return interaction.reply(tr(ctx, "off"));
        let rows = await leaders(ctx, limit);
        if (role) {
          const kept: typeof rows = [];
          let offset = 0;
          do {
            rows = await leaders(ctx, 100, offset);
            offset += rows.length;
            for (const r of rows) {
              if ((await ctx.server.member(r.userId))?.hasRole({ id: role.id })) kept.push(r);
              if (kept.length === limit) break;
            }
          } while (kept.length < limit && rows.length === 100);
          rows = kept;
        }
        const lines = rows.map((s) =>
          tr(ctx, "row", { rank: s.rank, id: s.userId, level: levelOf(s.xp), xp: s.xp }),
        );
        await interaction.reply({
          embeds: [
            {
              title: tr(ctx, "title") + (role ? " — " + role.name : ""),
              description: lines.length > 0 ? lines.join("\n") : tr(ctx, "empty"),
              color: "#f1c40f",
            },
          ],
          allowedMentions: { users: false },
        });
      },
    }),
  },

  schedules: {
    /** Yesterday's most active members, every day at 09:00 UTC. */
    recap: {
      cron: "0 9 * * *",
      async run(ctx) {
        if (!ctx.config.enabled) return;
        const yesterday = dayOf(new Date(Date.now() - 24 * 3600 * 1000));
        const prefix = `day:${yesterday}:`;
        const top = await standings(ctx, prefix);
        // Daily counters are only needed for this recap.
        const { items } = await ctx.kv.list({ prefix: "day:", limit: 1000 });
        for (const { key } of items) if (key.slice(4, 14) <= yesterday) await ctx.kv.delete(key);

        const channel = ctx.config.recap.channel ?? ctx.config.announce.channel;
        if (!ctx.config.recap.enabled || !channel || top.length === 0) return;
        const lines = top
          .slice(0, ctx.config.recap.top)
          .map((s, i) => `${["🥇", "🥈", "🥉"][i] ?? `#${i + 1}`} <@${s.userId}> — +${s.xp} XP`);
        const posted = await ctx.server.channel(channel).send({
          embeds: [
            {
              title: tr(ctx, "recap", { date: yesterday }),
              description: lines.join("\n"),
              color: "#f1c40f",
            },
          ],
          allowedMentions: { users: false },
        });
        for (const person of top.slice(0, ctx.config.recap.top))
          await ctx.kv.set("copy:" + person.userId + ":" + posted.id, {
            channelId: posted.channel.id,
            messageId: posted.id,
            kind: "recap",
          });
      },
    },
  },

  subscriptions: {
    /** Bonus XP for every voter of a closed poll (plugin polls). */
    "suggestions.statusChanged": bonus("approved", "authorId"),
    "starboard.starred": bonus("starred", "authorId"),
    "community-events.ended": bonus("attended", "attendees"),
    "voice-rooms.roomClosed": bonus("roomClosed", "ownerId"),
    async "polls.closed"(ctx, payload, meta) {
      if (!ctx.config.enabled || !ctx.config.pollBonusXp || !ctx.features.enabled("pollBonus"))
        return;
      const e = payload as { pollId: string; voters?: string[]; votersTruncated?: boolean };
      const origin = meta?.id ?? "legacy-poll:" + e.pollId;
      if (e.votersTruncated) {
        if (!ctx.features.enabled("pollPages")) throw new Error("Missing polls.voters grant");
        await ctx.schedule.after(1, "voter-page", {
          origin,
          pollId: e.pollId,
          xp: ctx.config.pollBonusXp,
        });
      } else if (e.voters) await batch(ctx, e.voters, ctx.config.pollBonusXp, origin);
    },
  },

  // Checked against the portal contract in routes.ts (copied into portals by `cicord portal typegen`).
  routes: defineRoutes<Routes>({
    "GET /seasons/:id": {
      access: "public",
      async handler(ctx, r) {
        return {
          entries: ctx.config.enabled
            ? (await ctx.kv.ranking("season:" + r.params.id).top({ limit: 100 })).map((e) => ({
                userId: e.member,
                xp: e.score,
                rank: e.rank,
              }))
            : [],
        };
      },
    },
    /** Public leaderboard for the community portal. `?limit=` 1-100 (default 25). */
    "GET /leaderboard": {
      access: "public",
      async handler(ctx, request) {
        const limit = Math.min(
          100,
          Math.max(1, Math.trunc(Number(request.query.limit ?? 25)) || 25),
        );
        return { items: ctx.config.enabled ? await leaderboard(ctx, limit) : [] };
      },
    },
    /** The viewer's own standing. */
    "GET /me": {
      access: "member",
      async handler(ctx, request) {
        const viewer = request.viewer;
        if (!viewer)
          return {
            status: 401,
            body: { error: { code: "unauthenticated", message: "login required" } },
          };
        const { xp, rank } = ctx.config.enabled
          ? await position(ctx, viewer.user.id)
          : { xp: 0, rank: null };
        return { userId: viewer.user.id, rank, xp, ...progress(xp) };
      },
    },
  }),
});
