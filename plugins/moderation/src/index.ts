import {
  command,
  definePlugin,
  type CommandInteraction,
  type Context,
  type Json,
  type Member,
  type RouteResponse,
} from "@cicord/sdk";
import {
  activeWarnings,
  duration,
  logLine,
  recordCase,
  warnPrefix,
  who,
  type Warning,
} from "./moderation.ts";

import { applyBan, expireBan, liftBan } from "./bans.ts";

import {
  caseCommand,
  historyCommand,
  noteCommand,
  listCases,
  memberHistory,
  migrateCases,
} from "./cases.ts";
import { purge, finishPurge } from "./purge.ts";

const DAY = 86_400;
const MINUTE_MS = 60_000;

/** Messages per member within the flood window (instance memory: resets on reload). */
const recent = new Map<string, number[]>();

type Moderator = { id: string; name: string } | null;

async function dm(ctx: Context, member: Member, text: string): Promise<boolean> {
  if (!ctx.config.dmMembers) return true;
  try {
    await member.send(text);
    return true;
  } catch (error) {
    ctx.log.info("moderation: could not DM the member", {
      member: member.id,
      error: String(error),
    });
    return false;
  }
}

/**
 * Applies a sanction: DM first (a kicked or banned member can no longer be reached), then
 * the action, then the case in the audit log. Returns whether the DM was delivered.
 */
async function sanction(
  ctx: Context,
  member: Member,
  action: "timeout" | "untimeout" | "kick" | "ban" | "tempban",
  reason: string,
  moderator: Moderator,
  opts: { minutes?: number; deleteMessages?: boolean } = {},
): Promise<boolean> {
  const server = ctx.server.name;
  const why = reason ? `: ${reason}` : ".";
  const text = {
    timeout: `You were timed out on **${server}** for ${duration(opts.minutes ?? 0)}${why}`,
    untimeout: `Your timeout on **${server}** was removed.`,
    kick: `You were kicked from **${server}**${why}`,
    tempban: `You were temporarily banned from **${server}** for ${duration(opts.minutes ?? 0)}${why}`,
    ban: `You were banned from **${server}**${why}`,
  }[action];
  const delivered = await dm(ctx, member, text);
  const auditReason = `${moderator ? moderator.name : "automatic"}: ${reason || "no reason"}`;
  switch (action) {
    case "timeout":
      await member.timeout((opts.minutes ?? 0) * MINUTE_MS, auditReason);
      break;
    case "untimeout":
      await member.timeout(0, auditReason);
      break;
    case "kick":
      await member.kick(auditReason);
      break;
    case "tempban":
    case "ban":
      await applyBan(
        ctx,
        who(member.user, member.displayName),
        moderator,
        reason,
        !!opts.deleteMessages,
        action === "tempban" ? opts.minutes : undefined,
      );
      return delivered;
  }
  await recordCase(ctx, {
    action,
    member: who(member.user, member.displayName),
    moderator,
    reason,
    ...(opts.minutes && action === "timeout" ? { durationMinutes: opts.minutes } : {}),
  });
  return delivered;
}

/**
 * Highest role position of a member (0: only @everyone). For the target (`strict`), a role
 * of unknown position makes the whole answer unknown; for the moderator, such a role
 * simply does not count. Either way an unknown position never helps the moderator.
 */
function topPosition(member: Member, strict: boolean): number | undefined {
  let top = 0;
  for (const role of member.roles) {
    if (role.position === undefined) {
      if (strict) return undefined;
    } else if (role.position > top) top = role.position;
  }
  return top;
}

const UNVERIFIABLE =
  "I cannot check the role hierarchy right now (server roles or owner not loaded yet): try again in a moment.";

/**
 * Discord only checks the bot's role hierarchy, so the plugin checks the moderator's: the
 * server owner may moderate anyone; nobody may moderate the owner; members with the
 * moderator or admin access level (spec.access) can only be moderated by an admin; and the
 * moderator's highest role must be strictly above the target's. Anything that cannot be
 * verified (an older engine, roles not cached) is refused.
 */
function hierarchyProblem(
  ownerId: string | undefined,
  moderator: Member | undefined,
  member: Member,
): string | undefined {
  if (ownerId === undefined) return UNVERIFIABLE;
  if (member.id === ownerId) return "You cannot moderate the server owner.";
  if (moderator?.id === ownerId) return undefined;
  if (!moderator) return "Moderation commands can only be used by members of the server.";
  if (member.access === undefined || moderator.access === undefined) return UNVERIFIABLE;
  if (member.access !== "member" && moderator.access !== "admin")
    return `${member.mention} is staff (${member.access} access): only an admin can moderate them.`;
  const theirs = topPosition(member, true);
  if (theirs === undefined) return UNVERIFIABLE;
  const mine = topPosition(moderator, false) ?? 0;
  if (mine <= theirs)
    return `You cannot moderate ${member.mention}: their highest role is not below yours.`;
  return undefined;
}

/** Resolves the target of a moderation command, or answers why it cannot be moderated. */
async function target(
  ctx: Context,
  interaction: CommandInteraction,
  userId: string,
): Promise<Member | undefined> {
  const member = await ctx.server.member(userId);
  let problem: string | undefined;
  if (!member) problem = "This user is not a member of the server.";
  else if (member.id === interaction.user.id) problem = "You cannot moderate yourself.";
  else if (member.user.bot) problem = "Bots cannot be moderated with these commands.";
  else problem = hierarchyProblem(ctx.server.ownerId, interaction.member, member);
  if (problem) {
    await interaction.reply({ content: problem, ephemeral: true });
    return undefined;
  }
  return member;
}

function moderatorOf(interaction: CommandInteraction): Moderator {
  return who(interaction.user, interaction.member?.displayName);
}

/** Runs a sanction from a command and reports the outcome to the moderator. */
async function sanctionCommand(
  ctx: Context,
  interaction: CommandInteraction,
  member: Member,
  action: "timeout" | "untimeout" | "kick" | "ban" | "tempban",
  reason: string,
  opts: { minutes?: number; deleteMessages?: boolean } = {},
) {
  const done: Record<typeof action, string> = {
    timeout: `⏳ ${member.mention} is timed out for ${duration(opts.minutes ?? 0)}.`,
    untimeout: `✅ The timeout of ${member.mention} was removed.`,
    kick: `👢 ${member.mention} was kicked.`,
    tempban: `🔨 ${member.mention} was banned for ${duration(opts.minutes ?? 0)}.`,
    ban: `🔨 ${member.mention} was banned.`,
  };
  let delivered: boolean;
  try {
    delivered = await sanction(ctx, member, action, reason, moderatorOf(interaction), opts);
  } catch (error) {
    ctx.log.warn("moderation: action failed", { action, member: member.id, error: String(error) });
    await interaction.reply(
      `I could not ${action} ${member.mention}: check that my role is above theirs and that I have the permission.`,
    );
    return;
  }
  await interaction.reply(done[action]);
  if (!delivered)
    await interaction.followUp({
      content: "⚠️ I could not DM the member (DMs closed?).",
      ephemeral: true,
    });
}

export default definePlugin({
  async onStart(ctx) {
    await migrateCases(ctx);
  },
  commands: {
    case: caseCommand,
    history: historyCommand,
    note: noteCommand,
    purge,
    warn: command({
      description: "Warn a member (warnings expire; repeated warnings escalate)",
      ephemeral: true,
      permissions: ["ModerateMembers"],
      options: {
        member: { type: "user", description: "Member to warn", required: true },
        reason: { type: "string", description: "Why (sent to the member)", required: true },
        evidence: { type: "attachment", description: "Screenshot or file" },
      },
      async run(ctx, interaction) {
        const { member: user, reason, evidence } = interaction.options;
        const member = await target(ctx, interaction, user.id);
        if (!member) return;
        const moderator = moderatorOf(interaction);
        const c = await recordCase(ctx, {
          action: "warn",
          member: who(member.user, member.displayName),
          moderator,
          reason,
          ...(evidence ? { evidence: evidence.url } : {}),
        });
        const warning: Warning = {
          case: c.number,
          reason,
          moderator: moderator?.id ?? null,
          ...(evidence ? { evidence: evidence.url } : {}),
          at: c.at,
        };
        await ctx.kv.set(
          `${warnPrefix(member.id)}${String(c.number).padStart(8, "0")}`,
          warning as unknown as Json,
          {
            ttlSeconds: Math.max(1, Math.round(ctx.config.warningDays * DAY)),
          },
        );
        const count = (await activeWarnings(ctx, member.id)).length;
        await interaction.reply(
          `⚠️ ${member.mention} was warned (case #${c.number}). Active warnings: ${count}.`,
        );
        const delivered = await dm(
          ctx,
          member,
          `⚠️ You received a warning on **${ctx.server.name}**: ${reason}`,
        );
        if (!delivered)
          await interaction.followUp({
            content: "⚠️ I could not DM the member (DMs closed?).",
            ephemeral: true,
          });

        const rule = ctx.config.escalation.find((r) => r.warnings === count);
        if (!rule) return;
        const why = `${count} active warnings`;
        try {
          await sanction(ctx, member, rule.action, why, null, { minutes: rule.durationMinutes });
          await interaction.followUp({
            content: `Automatic ${rule.action} after ${why}.`,
            ephemeral: true,
          });
        } catch (error) {
          ctx.log.warn("moderation: escalation failed", {
            member: member.id,
            action: rule.action,
            error: String(error),
          });
          await interaction.followUp({
            content: `The automatic ${rule.action} failed.`,
            ephemeral: true,
          });
        }
      },
    }),

    warnings: command({
      description: "Active warnings of a member",
      ephemeral: true,
      permissions: ["ModerateMembers"],
      options: { member: { type: "user", description: "Member", required: true } },
      async run(ctx, interaction) {
        const user = interaction.options.member;
        const list = await activeWarnings(ctx, user.id);
        if (list.length === 0) {
          await interaction.reply(`${user.mention} has no active warnings.`);
          return;
        }
        const lines = list.map(
          (w) => `**#${w.case}** <t:${Math.floor(Date.parse(w.at) / 1000)}:d> — ${w.reason}`,
        );
        await interaction.reply({
          embeds: [
            {
              title: `Warnings of ${user.displayName} (${list.length})`,
              description: lines.join("\n"),
              color: "#f1c40f",
            },
          ],
        });
      },
    }),

    timeout: command({
      description: "Time a member out (or remove a timeout)",
      ephemeral: true,
      permissions: ["ModerateMembers"],
      options: {
        member: { type: "user", description: "Member", required: true },
        duration: {
          type: "integer",
          description: "How long",
          required: true,
          choices: [
            { name: "60 seconds", value: 1 },
            { name: "5 minutes", value: 5 },
            { name: "10 minutes", value: 10 },
            { name: "1 hour", value: 60 },
            { name: "1 day", value: 1440 },
            { name: "1 week", value: 10080 },
            { name: "Remove the timeout", value: 0 },
          ],
        },
        reason: { type: "string", description: "Why (sent to the member)" },
      },
      async run(ctx, interaction) {
        const { member: user, duration: minutes, reason = "" } = interaction.options;
        const member = await target(ctx, interaction, user.id);
        if (!member) return;
        if (minutes === 0) await sanctionCommand(ctx, interaction, member, "untimeout", reason);
        else await sanctionCommand(ctx, interaction, member, "timeout", reason, { minutes });
      },
    }),

    kick: command({
      description: "Kick a member",
      ephemeral: true,
      permissions: ["KickMembers"],
      options: {
        member: { type: "user", description: "Member", required: true },
        reason: { type: "string", description: "Why (sent to the member)" },
      },
      async run(ctx, interaction) {
        const { member: user, reason = "" } = interaction.options;
        const member = await target(ctx, interaction, user.id);
        if (member) await sanctionCommand(ctx, interaction, member, "kick", reason);
      },
    }),

    ban: command({
      description: "Ban a member",
      ephemeral: true,
      permissions: ["BanMembers"],
      options: {
        member: { type: "user", description: "Member", required: true },
        reason: { type: "string", description: "Why (sent to the member)" },
        duration: {
          type: "integer",
          description: "Temporary ban length in minutes",
          minValue: 1,
          maxValue: 525600,
        },
        delete_messages: {
          type: "boolean",
          description: "Also delete their messages of the last 24 h",
        },
      },
      async run(ctx, interaction) {
        const {
          member: user,
          reason = "",
          delete_messages: deleteMessages = false,
        } = interaction.options;
        const minutes = interaction.options.duration;
        const present = await ctx.server.member(user.id);
        if (!present) {
          if (
            !ctx.server.ownerId ||
            !interaction.member ||
            user.id === ctx.server.ownerId ||
            user.id === interaction.user.id ||
            user.bot
          ) {
            await interaction.reply("This user cannot be banned.");
            return;
          }
          await applyBan(ctx, who(user), moderatorOf(interaction), reason, deleteMessages, minutes);
          await interaction.reply(`🔨 ${user.mention} was banned.`);
          return;
        }
        const member = await target(ctx, interaction, user.id);
        if (member)
          await sanctionCommand(ctx, interaction, member, minutes ? "tempban" : "ban", reason, {
            deleteMessages,
            ...(minutes ? { minutes } : {}),
          });
      },
    }),

    unban: command({
      description: "Lift a ban",
      ephemeral: true,
      permissions: ["BanMembers"],
      options: {
        member: { type: "user", description: "User to unban", required: true },
        reason: { type: "string", description: "Reason", required: true },
      },
      async run(ctx, it) {
        await liftBan(ctx, who(it.options.member), who(it.user), it.options.reason);
        await it.reply("Ban lifted.");
      },
    }),
  },

  components: { "purge-confirm": finishPurge, "purge-cancel": finishPurge },
  tasks: {
    migrateCases,
    async expireBan(ctx, payload) {
      const data = payload as { number?: number; user?: string } | undefined;
      if (!data || !Number.isSafeInteger(data.number) || typeof data.user !== "string")
        throw new Error("Invalid expiry payload");
      await expireBan(ctx, data.number!, data.user);
    },
  },
  events: {
    async memberJoin(ctx, member) {
      if (ctx.config.log.joins)
        await logLine(ctx, `📥 ${member.mention} (${member.user.username}) joined.`, "#2ecc71");
    },
    async memberLeave(ctx, user) {
      recent.delete(user.id);
      if (ctx.config.log.leaves)
        await logLine(ctx, `📤 ${user.mention} (${user.username}) left.`, "#e74c3c");
    },
    async memberUpdate(ctx, member, previous) {
      if (!ctx.config.log.updates || !previous) return;
      const changes: string[] = [];
      if ((previous.nickname ?? null) !== (member.nickname ?? null)) {
        changes.push(`nickname: ${previous.nickname ?? "—"} → ${member.nickname ?? "—"}`);
      }
      const before = new Set(previous.roles.map((r) => r.id));
      const after = new Set(member.roles.map((r) => r.id));
      const added = member.roles.filter((r) => !before.has(r.id)).map((r) => `+${r.name}`);
      const removed = previous.roles.filter((r) => !after.has(r.id)).map((r) => `-${r.name}`);
      if (added.length + removed.length > 0)
        changes.push(`roles: ${[...added, ...removed].join(" ")}`);
      if (changes.length > 0) await logLine(ctx, `✏️ ${member.mention}: ${changes.join("; ")}`);
    },

    /** Flood protection. Only authors and timestamps are used (no MessageContent). */
    async messageCreate(ctx, message) {
      const f = ctx.config.flood;
      const member = message.member;
      if (!f.enabled || message.author.bot || !member) return;
      if (f.exemptRoles.some((r) => member.hasRole(r))) return;
      const now = Date.now();
      const times = (recent.get(member.id) ?? []).filter((t) => now - t < f.seconds * 1000);
      times.push(now);
      recent.set(member.id, times);
      if (times.length < f.messages) return;
      recent.delete(member.id);
      try {
        await message.delete("flood protection");
      } catch (error) {
        ctx.log.warn("moderation: could not delete a flood message", { error: String(error) });
      }
      try {
        await sanction(ctx, member, "timeout", `${times.length} messages in ${f.seconds} s`, null, {
          minutes: f.timeoutMinutes,
        });
      } catch (error) {
        // e.g. the server owner, or a member ranked above the bot: exempt them in the config.
        ctx.log.warn("moderation: flood timeout failed", {
          member: member.id,
          error: String(error),
        });
      }
    },
  },

  routes: {
    "GET /members/:id": { access: "member", handler: memberHistory },
    "GET /cases": { access: "moderator", handler: listCases },
    /** Active warnings of a member (staff portal). */
    "GET /warnings/:userId": {
      access: "moderator",
      async handler(ctx, request): Promise<RouteResponse> {
        const items = await activeWarnings(ctx, request.params["userId"] ?? "");
        return { items: items as unknown as Json };
      },
    },
    /** Clears a member's warnings (admins only). */
    "DELETE /warnings/:userId": {
      access: "admin",
      async handler(ctx, request): Promise<RouteResponse> {
        const userId = request.params["userId"] ?? "";
        const { items } = await ctx.kv.list({ prefix: warnPrefix(userId), limit: 1000 });
        for (const { key } of items) await ctx.kv.delete(key);
        if (items.length > 0) {
          const viewer = request.viewer;
          await recordCase(ctx, {
            action: "clear",
            member: { id: userId, name: (await ctx.server.member(userId))?.displayName ?? userId },
            moderator: viewer ? who(viewer.user, viewer.member?.displayName) : null,
            reason: `${items.length} warning(s) cleared from the portal`,
          });
        }
        return { cleared: items.length };
      },
    },
  },
});
