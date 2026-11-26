import {
  definePlugin,
  type AuditLogEntry,
  type Context,
  type EventHandlers,
  type Json,
} from "@cicord/sdk";
import {
  auditFact,
  deadline,
  deletion,
  observeProof,
  probeDeletion,
  remember,
} from "./deletions.ts";
import {
  esc,
  feature,
  flush,
  housekeeping,
  ignored,
  migrate,
  record,
  snowflakeTime,
  tr,
  ts,
  type Group,
} from "./log.ts";
import { privacy } from "./privacy.ts";
import { routes } from "./search.ts";
import type { CaseNotice, PartnerNotice, PollNotice } from "./contracts.ts";

type Flag = keyof Context["config"]["events"];
type Info = { subjects?: string[]; sources?: string[]; origin?: string };
async function note(
  ctx: Context,
  flag: Flag,
  group: Group,
  key: string,
  vars: Record<string, string | number>,
  info: Info = {},
) {
  if (!ctx.config.enabled || !ctx.config.events[flag] || info.sources?.some((s) => ignored(ctx, s)))
    return;
  await record(
    ctx,
    {
      group,
      category: flag,
      text: tr(ctx, key, vars),
      subjects: info.subjects ?? [],
      sources: info.sources ?? [],
    },
    info.origin,
  );
}
function structural(ctx: Context, flag: Flag, key: string, id: string, source?: string) {
  return note(ctx, flag, "structure", key, { id }, { sources: source ? [source] : [] });
}
function groupFor(action: string): [Flag, Group] | undefined {
  const kind = action.split(".")[0];
  if (kind === "channel" || kind === "overwrite") return ["channels", "structure"];
  if (kind === "role") return ["roles", "structure"];
  if (kind === "thread") return ["threads", "structure"];
  if (kind === "emoji" || kind === "sticker") return ["expressions", "structure"];
  if (kind === "server") return ["server", "structure"];
  if (kind === "invite") return ["invites", "security"];
  if (kind === "automod") return ["automod", "security"];
  if (action === "member.ban" || action === "member.unban") return ["bans", "security"];
}
async function audit(ctx: Context, e: AuditLogEntry) {
  if (!ctx.config.enabled) return;
  if (e.action === "message.delete") {
    await observeProof(ctx, e);
    return;
  }
  const category = groupFor(e.action);
  if (!category) return;
  const [flag, group] = category;
  if (!ctx.config.events[flag]) return;
  const cicord = e.attribution.kind === "cicord" && e.attribution.certainty === "confirmed";
  const who = cicord
    ? tr(ctx, "via", { revision: e.attribution.revision?.slice(0, 12) ?? "—" })
    : e.actorId
      ? esc(e.actor?.username ?? e.actorId) + " (<@" + e.actorId + ">)"
      : tr(ctx, "unknown");
  const changes = e.changes
    .map((c) => {
      const add = c.addedPermissions?.join(", "),
        remove = c.removedPermissions?.join(", ");
      if (add || remove)
        return [
          c.key,
          add ? tr(ctx, "added", { value: add }) : "",
          remove ? tr(ctx, "removed", { value: remove }) : "",
        ]
          .filter(Boolean)
          .join(" ");
      if (c.key === "name" && typeof c.old === "string" && typeof c.new === "string")
        return tr(ctx, "renamed", { before: esc(c.old), after: esc(c.new) });
      return esc(c.key);
    })
    .join(" · ");
  // Invite targets can be active join codes. A reason is untrusted free text.
  const target = e.targetType === "invite" ? "—" : (e.targetId ?? "—");
  const sources = e.targetType === "channel" && e.targetId ? [e.targetId] : [];
  if (sources.some((id) => ignored(ctx, id))) return;
  // Do not relay private channel names or other change values across audiences.
  let details = changes;
  if (sources.length) {
    try {
      const dest = ctx.server.channel(ctx.config.channels?.[group] ?? ctx.config.channel!);
      if (
        dest.id !== sources[0] ||
        ctx.server.compareAudience({ id: sources[0]! }, dest) !== "same"
      )
        details = e.changes.map((c) => esc(c.key)).join(", ");
    } catch {
      details = "";
    }
  }
  await record(
    ctx,
    {
      group,
      category: flag,
      text: tr(ctx, "audit", {
        action: e.action,
        target,
        who,
        certainty:
          e.actorId || cicord
            ? tr(ctx, e.mergeable && !cicord ? "probable" : "confirmed")
            : tr(ctx, "unknown"),
        changes: details,
      }),
      subjects: [
        ...(e.actorId ? [e.actorId] : []),
        ...(e.targetType === "member" && e.targetId ? [e.targetId] : []),
      ],
      sources,
    },
    "audit-" + e.id,
    true,
  );
}

const events: EventHandlers = {
  auditLogEntry: audit,
  async memberJoin(ctx, m) {
    if (ctx.config.ignoreBots && m.user.bot) return;
    const created = snowflakeTime(m.id);
    await note(
      ctx,
      "joins",
      "members",
      "join",
      {
        who: m.mention,
        name: esc(m.user.username),
        age: ts(created),
        fresh: Date.now() - created < 604800000 ? tr(ctx, "fresh") : "",
      },
      { subjects: [m.id] },
    );
  },
  async memberLeave(ctx, u) {
    if (ctx.config.ignoreBots && u.bot) return;
    await note(
      ctx,
      "leaves",
      "members",
      "leave",
      { who: u.mention, name: esc(u.username) },
      { subjects: [u.id] },
    );
  },
  async memberUpdate(ctx, m, prev) {
    if (!prev || (ctx.config.ignoreBots && m.user.bot)) return;
    if (m.nickname !== prev.nickname)
      await note(
        ctx,
        "nicknames",
        "members",
        "nickname",
        { who: m.mention, before: esc(prev.nickname ?? "—"), after: esc(m.nickname ?? "—") },
        { subjects: [m.id] },
      );
    const plus = m.roles.filter((r) => !prev.roles.some((p) => p.id === r.id)),
      minus = prev.roles.filter((r) => !m.roles.some((p) => p.id === r.id));
    if (plus.length || minus.length)
      await note(
        ctx,
        "roles",
        "members",
        "roles",
        {
          who: m.mention,
          add: plus.map((r) => r.mention).join(" "),
          remove: minus.map((r) => r.mention).join(" "),
        },
        { subjects: [m.id] },
      );
  },
  messageCreate: remember,
  messageDelete: (ctx, m) => deletion(ctx, m.id, m.channel),
  async messageUpdate(ctx, m) {
    await remember(ctx, m);
    if (!m.author?.id || (ctx.config.ignoreBots && m.author.bot)) return;
    await note(
      ctx,
      "messageEdits",
      "messages",
      "edit",
      { who: m.author.mention, channel: m.channel.mention, id: m.id },
      { subjects: [m.author.id], sources: [m.channel.id] },
    );
  },
  channelCreate: (ctx, e) =>
    structural(ctx, "channels", "channel.create", e.channel.id, e.channel.id),
  channelUpdate: (ctx, e) =>
    structural(ctx, "channels", "channel.update", e.channel.id, e.channel.id),
  channelDelete: (ctx, e) =>
    structural(ctx, "channels", "channel.delete", e.channel.id, e.channel.id),
  roleCreate: (ctx, e) => structural(ctx, "roles", "role.create", e.role.id),
  roleUpdate: (ctx, e) => structural(ctx, "roles", "role.update", e.role.id),
  roleDelete: (ctx, e) => structural(ctx, "roles", "role.delete", e.role.id),
  threadCreate: (ctx, e) => structural(ctx, "threads", "thread.create", e.thread.id, e.thread.id),
  threadDelete: (ctx, e) => structural(ctx, "threads", "thread.delete", e.thread.id, e.thread.id),
  expressionsUpdate: (ctx, e) =>
    note(ctx, "expressions", "structure", e.emojis ? "emoji" : "sticker", {
      count: (e.emojis ?? e.stickers ?? []).length,
    }),
  serverUpdate: (ctx, e) =>
    note(ctx, "server", "structure", "server", {
      keys: Object.keys(e.changes).map(esc).join(", "),
    }),
  banAdd: (ctx, e) =>
    note(ctx, "bans", "security", "ban", { who: e.user.mention }, { subjects: [e.user.id] }),
  banRemove: (ctx, e) =>
    note(ctx, "bans", "security", "unban", { who: e.user.mention }, { subjects: [e.user.id] }),
  inviteCreate: (ctx, e) =>
    note(
      ctx,
      "invites",
      "security",
      "invite.create",
      { channel: e.channelId ? "<#" + e.channelId + ">" : "—" },
      { subjects: e.inviter ? [e.inviter.id] : [], sources: e.channelId ? [e.channelId] : [] },
    ),
  inviteDelete: (ctx, e) =>
    note(
      ctx,
      "invites",
      "security",
      "invite.delete",
      { channel: e.channelId ? "<#" + e.channelId + ">" : "—" },
      { sources: e.channelId ? [e.channelId] : [] },
    ),
  voiceStateUpdate: (ctx, e) => {
    if (e.channel?.id === e.previous?.id || (ctx.config.ignoreBots && e.user.bot)) return;
    return note(
      ctx,
      "voice",
      "voice",
      e.channel && e.previous ? "voice.move" : e.channel ? "voice.join" : "voice.leave",
      { who: e.user.mention, from: e.previous?.mention ?? "—", to: e.channel?.mention ?? "—" },
      {
        subjects: [e.user.id],
        sources: [e.previous?.id, e.channel?.id].filter((x): x is string => !!x),
      },
    );
  },
  automodAction: (ctx, e) =>
    note(
      ctx,
      "automod",
      "security",
      "automod",
      { who: "<@" + e.userId + ">", action: esc(e.action), rule: e.rule },
      { subjects: [e.userId], sources: e.channelId ? [e.channelId] : [] },
    ),
};

type Meta = { id: string };
function partner(topic: string) {
  return async (ctx: Context, payload: Json, meta?: Meta) => {
    if (
      !ctx.config.enabled ||
      !ctx.config.events.plugins ||
      !feature(ctx, "partners") ||
      !payload ||
      typeof payload !== "object" ||
      Array.isArray(payload)
    )
      return;
    const c = payload as PartnerNotice & CaseNotice & PollNotice;
    const origin = meta?.id ? "event-" + meta.id : undefined;
    if (topic === "moderation.case") {
      if (!c.member?.id || !c.action) return;
      await note(
        ctx,
        "moderation",
        "plugins",
        "case",
        {
          number: c.number ?? "—",
          action: esc(c.action),
          who: "<@" + c.member.id + ">",
          by: c.moderator?.id ? "<@" + c.moderator.id + ">" : tr(ctx, "automatic"),
        },
        { subjects: [c.member.id, ...(c.moderator?.id ? [c.moderator.id] : [])], origin },
      );
      return;
    }
    if (topic === "polls.closed") {
      if (!c.pollId) return;
      await note(
        ctx,
        "polls",
        "plugins",
        "poll",
        {
          id: esc(c.pollId),
          count: c.voterCount ?? (Array.isArray(payload["voters"]) ? payload["voters"].length : 0),
        },
        { sources: c.channelId ? [c.channelId] : [], origin },
      );
      return;
    }
    const subjects = [c.userId, c.memberId, c.authorId, c.actorId, c.ownerId, c.by].filter(
      (x): x is string => typeof x === "string",
    );
    await note(
      ctx,
      "plugins",
      "plugins",
      "partner",
      { event: topic, who: subjects.map((x) => "<@" + x + ">").join(", ") || "—" },
      { subjects, sources: c.channelId ? [c.channelId] : [], origin },
    );
  };
}
const topics = [
  "moderation.case",
  "moderation.caseUpdated",
  "moderation.appeal",
  "polls.closed",
  "levels.levelUp",
  "guard.violation",
  "guard.raid",
  "anti-nuke.triggered",
  "verification.passed",
  "verification.failed",
  "tickets.opened",
  "tickets.closed",
  "giveaways.started",
  "giveaways.ended",
  "economy.transaction",
  "member-roles.tempRoleExpired",
];
export default definePlugin({
  async onStart(ctx) {
    if (ctx.config.enabled && (await ctx.kv.get("meta:schema")) !== 2)
      await ctx.schedule.after(1, "migrate");
  },
  events,
  subscriptions: Object.fromEntries(topics.map((topic) => [topic, partner(topic)])),
  routes,
  privacy: {
    async export(ctx, id) {
      return (await privacy(ctx, id, false)).records;
    },
    async erase(ctx, id) {
      return { erased: (await privacy(ctx, id, true)).erased };
    },
  },
  tasks: {
    async probeDeletion(ctx, v) {
      if (
        v &&
        typeof v === "object" &&
        !Array.isArray(v) &&
        typeof v.key === "string" &&
        typeof v.attempt === "number"
      )
        await probeDeletion(ctx, v.key, v.attempt);
    },
    async cleanup(ctx) {
      await housekeeping(ctx);
    },
    async auditFact(ctx, v) {
      if (
        v &&
        typeof v === "object" &&
        !Array.isArray(v) &&
        typeof v.proof === "string" &&
        typeof v.count === "number"
      )
        await auditFact(ctx, v.proof, v.count);
    },
    async flush(ctx) {
      await flush(ctx);
    },
    async migrate(ctx) {
      await migrate(ctx);
    },
    async deletionDeadline(ctx, v) {
      if (v && typeof v === "object" && !Array.isArray(v) && typeof v.key === "string")
        await deadline(ctx, v.key);
    },
  },
  schedules: {
    sweep: {
      cron: "@every 1m",
      async run(ctx) {
        await housekeeping(ctx);
        if (!ctx.config.enabled) return;
        await migrate(ctx);
        await flush(ctx, true);
        const cursor = await ctx.kv.get<string>("deadline:cursor");
        const page = await ctx.kv.list({ prefix: "pending:", limit: 30, cursor });
        for (const item of page.items)
          if (
            item.value &&
            typeof item.value === "object" &&
            !Array.isArray(item.value) &&
            Number(item.value.at) + 30_000 <= Date.now()
          )
            await deadline(ctx, item.key);
        if (page.cursor) await ctx.kv.set("deadline:cursor", page.cursor);
        else await ctx.kv.delete("deadline:cursor");
      },
    },
  },
});
