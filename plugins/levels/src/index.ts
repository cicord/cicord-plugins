import {
  command,
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
  dayKey,
  dayOf,
  leaderboard,
  levelOf,
  progress,
  reactionKey,
  render,
  saveProfile,
  standings,
  xpKey,
} from "./levels.ts";
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
): Promise<number> {
  if (amount === 0) return (await ctx.kv.get<number>(xpKey(userId))) ?? 0;
  const total = await ctx.kv.increment(xpKey(userId), amount);
  if (amount > 0) await ctx.kv.increment(dayKey(dayOf(new Date()), userId), amount);
  const before = levelOf(total - amount);
  const after = levelOf(total);
  if (after > before) await levelUp(ctx, userId, after, from);
  return total;
}

async function levelUp(ctx: Context, userId: string, level: number, from: AwardContext) {
  ctx.log.info("level up", { member: userId, level });
  const member = from.member ?? (await ctx.server.member(userId));
  if (member) await applyRewards(ctx, member, level);

  const text = render(ctx.config.announce.message, {
    member: `<@${userId}>`,
    level: String(level),
  });
  // The message may be gone (deleted by a moderator or another plugin): never fail the XP.
  try {
    if (ctx.config.announce.channel) {
      await ctx.server
        .channel(ctx.config.announce.channel)
        .send({ content: text, allowedMentions: { users: true } });
    } else if (from.message) {
      await from.message.reply({ content: text, allowedMentions: { users: true } });
    }
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
    const wanted = r.keep || r.level === highest;
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

function rankCard(name: string, xp: number, rank: number, of: number): string {
  const p = progress(xp);
  return [
    `**${name}** — level **${p.level}** · ${xp} XP${rank > 0 ? ` · rank #${rank} of ${of}` : ""}`,
    `${bar(p)} ${p.current}/${p.needed} XP to level ${p.level + 1}`,
  ].join("\n");
}

export default definePlugin({
  events: {
    async messageCreate(ctx, message) {
      if (message.author.bot || !message.member) return;
      if (
        ctx.config.ignoredChannels.some((key) => ctx.server.channel(key).id === message.channel.id)
      )
        return;
      if (message.content.trim().length < ctx.config.minLength) return;
      const userId = message.author.id;
      // Remember the author for reactions (the reaction events only carry the message id).
      if (ctx.config.reactionXp > 0)
        await ctx.kv.set(authorKey(message.id), userId, { ttlSeconds: WEEK });
      if (await ctx.kv.get(cooldownKey(userId))) return;
      if (ctx.config.cooldownSeconds > 0)
        await ctx.kv.set(cooldownKey(userId), true, { ttlSeconds: ctx.config.cooldownSeconds });
      await saveProfile(ctx, message.author, message.member.displayName);
      await award(ctx, userId, ctx.config.xpPerMessage, { message, member: message.member });
    },

    /** `reaction.message` is partial (id + channel): the author comes from our own records. */
    async reactionAdd(ctx, { message, user, emoji }) {
      if (user.bot || ctx.config.reactionXp === 0) return;
      const author = await ctx.kv.get<string>(authorKey(message.id));
      if (!author || author === user.id) return;
      const { items } = await ctx.kv.list({ prefix: `react:${message.id}:${user.id}:`, limit: 1 });
      await ctx.kv.set(reactionKey(message.id, user.id, emoji), true, { ttlSeconds: WEEK });
      if (items.length === 0) await award(ctx, author, ctx.config.reactionXp);
    },

    async reactionRemove(ctx, { message, user, emoji }) {
      const key = reactionKey(message.id, user.id, emoji);
      if (!(await ctx.kv.get(key))) return;
      await ctx.kv.delete(key);
      const { items } = await ctx.kv.list({ prefix: `react:${message.id}:${user.id}:`, limit: 1 });
      const author = await ctx.kv.get<string>(authorKey(message.id));
      if (author && items.length === 0) await award(ctx, author, -ctx.config.reactionXp);
    },
  },

  commands: {
    rank: command({
      description: "Your level and XP (or another member's)",
      ephemeral: true,
      options: { member: { type: "user", description: "Member to look up" } },
      async run(ctx, interaction) {
        const target = interaction.options.member ?? interaction.user;
        const all = await standings(ctx);
        const i = all.findIndex((s) => s.userId === target.id);
        const xp = i >= 0 ? (all[i]?.xp ?? 0) : 0;
        const name =
          target.id === interaction.user.id
            ? (interaction.member?.displayName ?? target.displayName)
            : target.displayName;
        const url = await ctx.portal.link("/leaderboard", {
          member: interaction.member ?? interaction.user,
        });
        // No `ephemeral` here: the command's `ephemeral: true` is the default.
        await interaction.reply({
          content:
            xp > 0
              ? rankCard(name, xp, i + 1, all.length)
              : `**${name}** has no XP yet. Say hi in the chat!`,
          components: [
            { type: "row", components: [{ type: "link", label: "Leaderboard", emoji: "🏆", url }] },
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
        let rows = (await standings(ctx)).map((s, i) => ({ ...s, rank: i + 1 }));
        if (role) {
          const kept: typeof rows = [];
          for (const s of rows) {
            if (kept.length >= limit) break;
            const m = await ctx.server.member(s.userId);
            if (m?.hasRole({ id: role.id })) kept.push(s);
          }
          rows = kept;
        }
        rows = rows.slice(0, limit);
        const lines = rows.map(
          (s) => `**#${s.rank}** <@${s.userId}> — level ${levelOf(s.xp)} · ${s.xp} XP`,
        );
        await interaction.reply({
          embeds: [
            {
              title: role ? `🏆 Top members — ${role.name}` : "🏆 Top members",
              description: lines.length > 0 ? lines.join("\n") : "Nobody has XP yet.",
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
        await ctx.server.channel(channel).send({
          embeds: [
            {
              title: `Yesterday's most active members (${yesterday})`,
              description: lines.join("\n"),
              color: "#f1c40f",
            },
          ],
          allowedMentions: { users: false },
        });
      },
    },
  },

  subscriptions: {
    /** Bonus XP for every voter of a closed poll (plugin polls). */
    async "polls.closed"(ctx, payload) {
      const voters = (payload as { voters?: unknown }).voters;
      if (ctx.config.pollBonusXp === 0 || !Array.isArray(voters)) return;
      for (const id of voters) {
        if (typeof id !== "string") continue;
        // Keep the public leaderboard readable for members who earned XP only by voting.
        const member = await ctx.server.member(id);
        if (member) await saveProfile(ctx, member.user, member.displayName);
        await award(ctx, id, ctx.config.pollBonusXp, member ? { member } : {});
      }
    },
  },

  // Checked against the portal contract in routes.ts (copied into portals by `cicord portal typegen`).
  routes: defineRoutes<Routes>({
    /** Public leaderboard for the community portal. `?limit=` 1-100 (default 25). */
    "GET /leaderboard": {
      access: "public",
      async handler(ctx, request) {
        const limit = Math.min(
          100,
          Math.max(1, Math.trunc(Number(request.query.limit ?? 25)) || 25),
        );
        return { items: await leaderboard(ctx, limit) };
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
        const all = await standings(ctx);
        const i = all.findIndex((s) => s.userId === viewer.user.id);
        const xp = i >= 0 ? (all[i]?.xp ?? 0) : 0;
        return { userId: viewer.user.id, rank: i >= 0 ? i + 1 : null, xp, ...progress(xp) };
      },
    },
  }),
});
