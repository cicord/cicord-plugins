import {
  command,
  query,
  action,
  InteropError,
  type InteropCall,
  definePlugin,
  type CommandInteraction,
  type Interaction,
  type Attachment,
  type Context,
  type Json,
  type Member,
  type RouteResponse,
} from "@cicord/sdk";
import {
  activeWarnings,
  duration,
  deliverCase,
  expireCaseLog,
  recordCase,
  warnPrefix,
  who,
  type Warning,
  type Case,
  saveNewCase,
} from "./moderation.ts";

import { applyBan, bindBanEvidence, expireBan, liftBan } from "./bans.ts";

import {
  history,
  memberCase,
  caseCommand,
  historyCommand,
  noteCommand,
  listCases,
  memberHistory,
  migrateCases,
} from "./cases.ts";
import { purge, finishPurge, previewPurge } from "./purge.ts";

import { writeActivity, expireActivity } from "./activity.ts";
import { serialize } from "./queue.ts";
import {
  QuarantineRefusal,
  quarantine,
  release,
  trackQuarantine,
  staffRoleChange,
  quarantineTask,
  excludeSavedRole,
} from "./quarantine.ts";
import {
  appealLink,
  linkMessage,
  caseView,
  submitAppeal,
  listAppeals,
  decideAppeal,
  renew,
} from "./appeals.ts";
import { privacy } from "./privacy.ts";
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
  opts: { minutes?: number; deleteMessages?: boolean; source?: Case["source"] } = {},
) {
  const server = ctx.server.name;
  const why = reason ? `: ${reason}` : ".";
  const text = {
    timeout: ctx.i18n.t("dm.timeout", {
      server: server,
      duration: duration(ctx, opts.minutes ?? 0),
      reason: why,
    }),
    untimeout: ctx.i18n.t("dm.untimeout", { server: server }),
    kick: ctx.i18n.t("dm.kick", { server: server, reason: why }),
    tempban: ctx.i18n.t("dm.tempban", {
      server: server,
      duration: duration(ctx, opts.minutes ?? 0),
      reason: why,
    }),
    ban: ctx.i18n.t("dm.ban", { server: server, reason: why }),
  }[action];
  const source = opts.source ?? { type: moderator ? "command" : "escalation" };
  const actor = who(member.user, member.displayName);
  if (action === "ban" || action === "tempban") {
    let delivered = true;
    const c = await applyBan(
      ctx,
      actor,
      moderator,
      reason,
      !!opts.deleteMessages,
      action === "tempban" ? opts.minutes : undefined,
      {
        source,
        beforeDiscord: async (c) => {
          delivered = await dm(ctx, member, await linkMessage(ctx, c, text));
        },
      },
    );
    return { c, delivered };
  }
  return serialize("timeout:" + member.id, async () => {
    const c: Case = {
      number: await ctx.kv.increment("cases"),
      action,
      reason,
      moderator,
      member: actor,
      at: new Date().toISOString(),
      source,
      status: "active",
      ...(action === "timeout" ? { durationMinutes: opts.minutes } : {}),
    };
    const delivered = await dm(
      ctx,
      member,
      action === "untimeout" ? text : await linkMessage(ctx, c, text),
    );
    const auditReason = (moderator?.name ?? "automatic") + ": " + (reason || "no reason");
    if (action === "kick") await member.kick(auditReason);
    else {
      await member.timeout((opts.minutes ?? 0) * MINUTE_MS, auditReason);
      const actual =
        action === "timeout" ? (await ctx.server.member(member.id))?.timedOutUntil : undefined;
      if (actual) {
        c.expiresAt = actual.toISOString();
        await ctx.kv.set("timeout:" + member.id, { number: c.number, until: c.expiresAt });
      } else await ctx.kv.delete("timeout:" + member.id);
    }
    return { c: await saveNewCase(ctx, c), delivered };
  });
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

/**
 * Discord only checks the bot's role hierarchy, so the plugin checks the moderator's: the
 * server owner may moderate anyone; nobody may moderate the owner; members with the
 * moderator or admin access level (spec.access) can only be moderated by an admin; and the
 * moderator's highest role must be strictly above the target's. Anything that cannot be
 * verified (an older engine, roles not cached) is refused.
 */
function hierarchyProblem(
  ctx: Context,
  ownerId: string | undefined,
  moderator: Member | undefined,
  member: Member,
): string | undefined {
  if (ownerId === undefined) return ctx.i18n.t("hierarchy.unknown");
  if (member.id === ownerId) return ctx.i18n.t("hierarchy.owner");
  if (moderator?.id === ownerId) return undefined;
  if (!moderator) return ctx.i18n.t("hierarchy.guild");
  if (member.access === undefined || moderator.access === undefined)
    return ctx.i18n.t("hierarchy.unknown");
  if (member.access !== "member" && moderator.access !== "admin")
    return ctx.i18n.t("moderation.staffTarget", { member: member.mention, access: member.access });
  const theirs = topPosition(member, true);
  if (theirs === undefined) return ctx.i18n.t("hierarchy.unknown");
  const mine = topPosition(moderator, false) ?? 0;
  if (mine <= theirs) return ctx.i18n.t("moderation.hierarchy", { member: member.mention });
  return undefined;
}

/** Resolves the target of a moderation command, or answers why it cannot be moderated. */
async function target(
  ctx: Context,
  interaction: Interaction,
  userId: string,
): Promise<Member | undefined> {
  const member = await ctx.server.member(userId);
  let problem: string | undefined;
  if (!member) problem = ctx.i18n.t("hierarchy.absent");
  else if (member.id === interaction.user.id) problem = ctx.i18n.t("hierarchy.self");
  else if (member.user.bot) problem = ctx.i18n.t("hierarchy.bot");
  else problem = hierarchyProblem(ctx, ctx.server.ownerId, interaction.member, member);
  if (problem) {
    await interaction.reply({ content: problem, ephemeral: true });
    return undefined;
  }
  return member;
}

function moderatorOf(interaction: Interaction): Moderator {
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
    timeout: ctx.i18n.t("moderation.timeout", {
      member: member.mention,
      duration: duration(ctx, opts.minutes ?? 0),
    }),
    untimeout: ctx.i18n.t("moderation.untimeout", { member: member.mention }),
    kick: ctx.i18n.t("moderation.kick", { member: member.mention }),
    tempban: ctx.i18n.t("moderation.tempban", {
      member: member.mention,
      duration: duration(ctx, opts.minutes ?? 0),
    }),
    ban: ctx.i18n.t("moderation.ban", { member: member.mention }),
  };
  let delivered: boolean;
  try {
    delivered = (await sanction(ctx, member, action, reason, moderatorOf(interaction), opts))
      .delivered;
  } catch (error) {
    ctx.log.warn("moderation: action failed", { action, member: member.id, error: String(error) });
    await interaction.reply(
      ctx.i18n.t("moderation.failed", { action: action, member: member.mention }),
    );
    return;
  }
  await interaction.reply(done[action]);
  if (!delivered)
    await interaction.followUp({
      content: ctx.i18n.t("dm.failed"),
      ephemeral: true,
    });
}

export default definePlugin({
  async onStart(ctx) {
    if (ctx.config.webhook?.url)
      ctx.log.warn("webhook.url is deprecated; configure the WEBHOOK_URL secret.");
    const guard = ctx.plugins.hasFeature("guard", "duplicates");
    const audit = ctx.plugins.has("audit-log");
    if (guard || !ctx.config.flood.enabled)
      ctx.features.report(
        "legacyFlood",
        false,
        guard ? "guard handles duplicates" : "disabled in configuration",
      );
    if (audit) ctx.features.report("legacyMemberLog", false, "audit-log handles member events");
    // Startup must finish before bounded migration work starts. A restart may
    // enqueue another wakeup; the stored cursor and case indexes tolerate replay.
    if (((await ctx.kv.get<number>("meta:schema")) ?? 1) < 3)
      await ctx.schedule.after(0, "migrateCases");
  },
  privacy,
  contextMenus: {
    Warn: {
      type: "user",
      permissions: ["ModerateMembers"],
      ephemeral: true,
      async run(ctx, it) {
        const targetMember = await target(ctx, it, it.target.id);
        if (!targetMember) return;
        await it.showModal({
          id: "warn:" + targetMember.id,
          title: ctx.i18n.t("warn.modalTitle"),
          fields: [
            {
              id: "reason",
              label: ctx.i18n.t("warn.modalReason"),
              style: "paragraph",
              required: true,
              maxLength: 512,
            },
          ],
        });
      },
    },
    "Purge after this message": {
      type: "message",
      permissions: ["ManageMessages"],
      ephemeral: true,
      async run(ctx, it) {
        await previewPurge(ctx, it, {
          count: ctx.config.purge.maxCount,
          after_message: it.target.id,
        });
      },
    },
  },
  modals: {
    warn: async (ctx, it) => {
      const user = it.modalId.split(":")[1],
        reason = it.fields.reason?.trim(),
        member = await ctx.server.member(it.user.id);
      if (
        !user ||
        !reason ||
        reason.length > 512 ||
        !member?.permissions?.includes("ModerateMembers")
      ) {
        await it.reply(ctx.i18n.t("warn.permission"));
        return;
      }
      await warnMember(ctx, it, user, reason);
    },
  },
  queries: {
    standing: query<{ userId: string }>({
      async run(ctx, { userId }) {
        const list = await history(ctx, userId, false, 1);
        return {
          activeWarnings: (await activeWarnings(ctx, userId)).length,
          quarantined: !!(await ctx.kv.get("quarantine:" + userId)),
          ...(list[0] ? { lastCase: list[0].number } : {}),
        };
      },
    }),
    cases: query<{ userId: string; limit?: number }>({
      async run(ctx, { userId, limit }, call) {
        const p = call.onBehalfOf,
          staff = p?.access === "moderator" || p?.access === "admin";
        if (!p || p.access === "scoped" || (!staff && p.userId !== userId))
          throw new InteropError("denied", "Member or staff identity required.");
        const cases = await history(ctx, userId, staff, Math.max(1, Math.min(limit ?? 10, 50)));
        return { cases: staff ? cases : cases.map(memberCase) };
      },
    }),
  },
  actions: { sanction: action<SanctionInput>({ run: interopSanction }) },
  commands: {
    case: caseCommand,
    history: historyCommand,
    note: noteCommand,
    purge,
    quarantine: command({
      description: "Quarantine a member",
      ephemeral: true,
      permissions: ["ModerateMembers"],
      options: {
        user: { type: "user", required: true, description: "Member" },
        reason: { type: "string", required: true, description: "Reason" },
        duration: {
          type: "integer",
          description: "Minutes (default seven days)",
          minValue: 1,
          maxValue: 10080,
        },
      },
      async run(ctx, it) {
        const m = await target(ctx, it, it.options.user.id);
        if (!m) return;
        try {
          const c = await quarantine(
            ctx,
            m,
            it.options.reason,
            it.options.duration ?? 10080,
            moderatorOf(it),
            { type: "command" },
          );
          await dm(
            ctx,
            m,
            await linkMessage(ctx, c, ctx.i18n.t("quarantine.dm", { reason: c.reason })),
          );
          await it.reply(ctx.i18n.t("quarantine.saved", { number: c.number }));
        } catch (error) {
          if (error instanceof QuarantineRefusal) await it.reply(error.message);
          else throw error;
        }
      },
    }),
    release: command({
      description: "Release a member from quarantine",
      ephemeral: true,
      permissions: ["ModerateMembers"],
      options: { user: { type: "user", required: true, description: "Member" } },
      async run(ctx, it) {
        const m = await target(ctx, it, it.options.user.id);
        if (!m) return;
        await it.reply(
          (await release(ctx, m.id, undefined, moderatorOf(it), "Staff released quarantine"))
            ? ctx.i18n.t("quarantine.lifted")
            : ctx.i18n.t("quarantine.absent"),
        );
      },
    }),
    lock: overlayCommand("lock"),
    slowmode: overlayCommand("slowmode"),
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
        await warnMember(ctx, interaction, user.id, reason, evidence);
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
          await interaction.reply(ctx.i18n.t("moderation.none", { member: user.mention }));
          return;
        }
        const lines = list.map(
          (w) => `**#${w.case}** <t:${Math.floor(Date.parse(w.at) / 1000)}:d> — ${w.reason}`,
        );
        await interaction.reply({
          embeds: [
            {
              title: ctx.i18n.t("moderation.warnings", {
                member: user.displayName,
                count: list.length,
              }),
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
            await interaction.reply(ctx.i18n.t("ban.denied"));
            return;
          }
          await applyBan(
            ctx,
            who(user),
            moderatorOf(interaction),
            reason,
            deleteMessages,
            minutes,
            {
              beforeDiscord: async (c) => {
                const url = await appealLink(ctx, c);
                if (url)
                  try {
                    await ctx.server.sendDM(
                      user.id,
                      ctx.i18n.t("appeal.link", { number: c.number, url }),
                    );
                  } catch {
                    ctx.log.info("Appeal DM unavailable", { number: c.number });
                  }
              },
            },
          );
          await interaction.reply(ctx.i18n.t("moderation.ban", { member: user.mention }));
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
        await it.reply(ctx.i18n.t("ban.lifted"));
      },
    }),
  },

  components: { "purge-confirm": finishPurge, "purge-cancel": finishPurge },
  tasks: {
    expireActivity,
    async applyQuarantine(ctx, payload) {
      await quarantineTask(ctx, payload, true);
    },
    async expireQuarantine(ctx, payload) {
      await quarantineTask(ctx, payload, false);
    },
    migrateCases,
    bindBanEvidence,
    deliverCase,
    expireCaseLog,
    expireBan,
  },
  events: {
    auditLogEntry: staffRoleChange,
    async memberJoin(ctx, member) {
      if (!ctx.plugins.has("audit-log") && ctx.config.log.joins)
        await writeActivity(
          ctx,
          member.id,
          ctx.i18n.t("moderation.join", { member: member.mention, user: member.user.username }),
          "#2ecc71",
        );
    },
    async memberLeave(ctx, user) {
      recent.delete(user.id);
      if (!ctx.plugins.has("audit-log") && ctx.config.log.leaves)
        await writeActivity(
          ctx,
          user.id,
          ctx.i18n.t("moderation.leave", { member: user.mention, user: user.username }),
          "#e74c3c",
        );
    },
    async memberUpdate(ctx, member, previous) {
      await trackQuarantine(ctx, member, previous);
      if (ctx.plugins.has("audit-log") || !ctx.config.log.updates || !previous) return;
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
      if (changes.length > 0)
        await writeActivity(ctx, member.id, `✏️ ${member.mention}: ${changes.join("; ")}`);
    },

    /** Flood protection. Only authors and timestamps are used (no MessageContent). */
    async messageCreate(ctx, message) {
      const f = ctx.config.flood;
      const member = message.member;
      if (
        !f.enabled ||
        ctx.plugins.hasFeature("guard", "duplicates") ||
        message.author.bot ||
        !member
      )
        return;
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
    "DELETE /quarantines/:id/roles/:role": {
      access: "moderator",
      async handler(ctx, r): Promise<RouteResponse> {
        const id = r.params.id,
          role = r.params.role,
          actor = r.viewer?.member;
        if (!actor || !id || !role) return { status: 403 };
        const m = await ctx.server.member(id);
        if (!m || hierarchyProblem(ctx, ctx.server.ownerId, actor, m)) return { status: 403 };
        return { status: (await excludeSavedRole(ctx, id, role)) ? 204 : 404 };
      },
    },
    "GET /stats/moderators": {
      access: "moderator",
      async handler(ctx, r): Promise<RouteResponse> {
        const offset = Number(r.query.cursor ?? 0);
        if (!Number.isSafeInteger(offset) || offset < 0) return { status: 400 };
        const rows = await ctx.kv.ranking("moderators").top({ offset, limit: 50 });
        return {
          items: rows.map((v) => ({ moderatorId: v.member, count: v.score })),
          next: rows.length === 50 ? String(offset + 50) : null,
        };
      },
    },
    "POST /scope/renew": { access: "scoped", handler: renew },
    "GET /appeal": { access: "scoped", handler: caseView },
    "POST /appeals": { access: "scoped", handler: submitAppeal },
    "GET /appeals": { access: "moderator", handler: listAppeals },
    "POST /appeals/:id/decision": { access: "moderator", handler: decideAppeal },
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

type SanctionInput = {
  userId: string;
  action: "warn" | "timeout" | "kick" | "ban" | "quarantine" | "release";
  reason: string;
  durationMinutes?: number;
};
async function interopSanction(ctx: Context, input: SanctionInput, call: InteropCall) {
  const { userId, reason, action, durationMinutes } = input;
  const deny = (message: string): never => {
    throw new InteropError("denied", message);
  };
  const owner = ctx.server.ownerId;
  if (!owner || userId === owner || userId === ctx.bot.user.id)
    deny("Owner or bot target is protected.");
  const p = call.onBehalfOf;
  if (p && p.access !== "admin" && p.access !== "moderator")
    deny("Staff authority is required for a human-initiated sanction.");
  const target = await ctx.server.member(userId);
  const source: NonNullable<Case["source"]> = {
    type: "plugin",
    plugin: call.caller.plugin,
    caller: { ...call.caller },
  };
  if (!target) {
    if (action !== "ban") throw new InteropError("invalid_input", "User is outside the server.");
    // An absent user has no member roles. Protect configured admin/moderator user IDs
    // by refusing to authorize an automated ban on an identity we cannot classify.
    deny("Cannot establish an absent user's moderation authority.");
  }
  const m = target!;
  const bot = await ctx.server.member(ctx.bot.user.id);
  const botTop = bot ? topPosition(bot, true) : undefined;
  const targetTop = topPosition(m, true);
  if (
    !m.access ||
    botTop === undefined ||
    targetTop === undefined ||
    targetTop >= botTop ||
    m.user.bot
  )
    deny("Target hierarchy cannot be safely moderated.");
  if (
    m.access !== "member" &&
    (!(call.caller.source === "cicord" || call.caller.verified) ||
      !ctx.config.sanction?.allowStaffTargets.some(
        (v) => v.bot === call.caller.bot && v.instance === call.caller.instance,
      ))
  )
    deny("This installation cannot sanction staff.");
  if (p) {
    const person = await ctx.server.member(p.userId);
    if (!person || person.id === userId || hierarchyProblem(ctx, owner, person, m))
      deny("Acting staff cannot moderate this member.");
  }
  const moderator = p ? { id: p.userId, name: p.userId } : null;
  if (action === "release") {
    const q = await ctx.kv.get<{ number: number }>("quarantine:" + m.id);
    if (!q || !(await release(ctx, m.id, q.number, moderator, reason)))
      throw new InteropError("invalid_input", ctx.i18n.t("quarantine.absent"));
    return { number: q.number, action, status: "lifted" };
  }
  let c: Case;
  if (action === "warn") {
    c = await recordCase(ctx, {
      action,
      reason,
      moderator,
      source,
      member: who(m.user, m.displayName),
    });
    const warning: Warning = { case: c.number, at: c.at, reason, moderator: moderator?.id ?? null };
    await ctx.kv.set(
      warnPrefix(m.id) + String(c.number).padStart(8, "0"),
      warning as unknown as Json,
      { ttlSeconds: Math.max(1, Math.round(ctx.config.warningDays * DAY)) },
    );
    await dm(ctx, m, await linkMessage(ctx, c, ctx.i18n.t("warn.direct", { reason })));
    const count = (await activeWarnings(ctx, m.id)).length,
      rule = ctx.config.escalation.find((v) => v.warnings === count);
    if (rule)
      await sanction(ctx, m, rule.action, count + " active warnings", null, {
        minutes: rule.durationMinutes,
      });
  } else if (action === "quarantine") {
    c = await quarantine(ctx, m, reason, durationMinutes ?? 10080, moderator, source);
    await dm(ctx, m, await linkMessage(ctx, c, ctx.i18n.t("quarantine.dm", { reason })));
  } else {
    if (action === "timeout" && !durationMinutes)
      throw new InteropError("invalid_input", "Timeout needs durationMinutes.");
    c = (
      await sanction(
        ctx,
        m,
        action === "ban" && durationMinutes ? "tempban" : action,
        reason,
        moderator,
        { minutes: durationMinutes, source },
      )
    ).c;
  }
  return { number: c.number, action: c.action, status: c.status ?? "active" };
}

function overlayCommand(kind: "lock" | "slowmode") {
  return command({
    description:
      kind === "lock" ? "Temporarily lock a managed channel" : "Temporarily raise channel slowmode",
    permissions: ["ManageChannels"],
    ephemeral: true,
    options: {
      channel: { type: "channel", description: "Managed channel", required: true },
      seconds: { type: "integer", description: "Slowmode seconds", minValue: 1, maxValue: 21600 },
      duration: {
        type: "integer",
        description: "Minutes, default 60",
        minValue: 1,
        maxValue: 10080,
      },
    },
    async run(ctx, it) {
      if (!ctx.features.enabled("lock")) {
        await it.reply(ctx.i18n.t("overlay.grant"));
        return;
      }
      const ch = it.options.channel,
        staff = await ctx.server.member(it.user.id);
      if (
        !staff ||
        !["admin", "moderator"].includes(staff.access ?? "") ||
        !staff.permissionsIn(ch).some((v) => v === "Administrator" || v === "ManageChannels")
      ) {
        await it.reply(ctx.i18n.t("overlay.authority"));
        return;
      }
      if (!ch.key) {
        await it.reply(ctx.i18n.t("overlay.managed"));
        return;
      }
      if (kind === "slowmode" && !it.options.seconds) {
        await it.reply(ctx.i18n.t("overlay.seconds"));
        return;
      }
      await ctx.server.overlays.apply({
        id: kind + "-" + ch.key,
        until: new Date(Date.now() + (it.options.duration ?? 60) * 60000),
        reason: kind + " requested by " + it.user.id,
        channels: {
          [ch.key]:
            kind === "lock"
              ? { overwrites: { "@everyone": { deny: ["SendMessages"] } } }
              : { slowmodeSeconds: it.options.seconds },
        },
      });
      await it.reply(ctx.i18n.t("overlay.applied", { kind, channel: ch.name }));
    },
  });
}

async function warnMember(
  ctx: Context,
  interaction: Interaction,
  userId: string,
  reason: string,
  evidence?: Attachment,
) {
  const member = await target(ctx, interaction, userId);
  if (!member) return;
  const moderator = moderatorOf(interaction);
  const c = await recordCase(ctx, {
    action: "warn",
    member: who(member.user, member.displayName),
    moderator,
    reason,
    ...(evidence
      ? {
          evidence: evidence.url,
          ...(interaction.channel ? { evidenceChannelId: interaction.channel.id } : {}),
        }
      : {}),
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
    ctx.i18n.t("moderation.warn", { member: member.mention, number: c.number, count: count }),
  );
  const delivered = await dm(
    ctx,
    member,
    await linkMessage(
      ctx,
      c,
      ctx.i18n.t("moderation.warnDM", { server: ctx.server.name, reason: reason }),
    ),
  );
  if (!delivered)
    await interaction.followUp({
      content: ctx.i18n.t("dm.failed"),
      ephemeral: true,
    });

  const rule = ctx.config.escalation.find((r) => r.warnings === count);
  if (!rule) return;
  const why = ctx.i18n.t("moderation.count", { count: count });
  try {
    await sanction(ctx, member, rule.action, why, null, { minutes: rule.durationMinutes });
    await interaction.followUp({
      content: ctx.i18n.t("moderation.escalated", { action: rule.action, reason: why }),
      ephemeral: true,
    });
  } catch (error) {
    ctx.log.warn("moderation: escalation failed", {
      member: member.id,
      action: rule.action,
      error: String(error),
    });
    await interaction.followUp({
      content: ctx.i18n.t("moderation.escalationFailed", { action: rule.action }),
      ephemeral: true,
    });
  }
}
