import { definePlugin, type Context, type Message, type Role, type TextChannel } from "@cicord/sdk";
import { esc, flush, messageLink, record, snowflakeTime, ts } from "./log.ts";

/**
 * Authors of recent messages (instance memory, lost on reload): a deletion event only
 * carries the message id, so this is how the log can say whose message it was.
 */
const authors = new Map<string, { id: string; name: string }>();
const AUTHORS_MAX = 5000;

/** Payload of `moderation.case`: the moderation plugin's `Case`. */
interface ModerationCase {
  number?: number;
  action?: string;
  member?: { id: string; name: string };
  moderator?: { id: string; name: string } | null;
  reason?: string;
  durationMinutes?: number;
}

/** Payload of `polls.closed` (see the polls plugin). */
interface PollClosed {
  pollId?: string;
  question?: string;
  winners?: string[];
  voters?: string[];
  channelId?: string;
  messageId?: string;
}

const ACTION_ICONS: Record<string, string> = {
  warn: "⚠️",
  timeout: "⏳",
  untimeout: "✅",
  kick: "👢",
  ban: "🔨",
  clear: "🧹",
};

function ignored(ctx: Context, channel: TextChannel): boolean {
  return ctx.config.ignoredChannels.some((key) => {
    try {
      return ctx.server.channel(key).id === channel.id;
    } catch {
      return false;
    }
  });
}

const roleList = (roles: readonly Role[]): string => roles.map((r) => r.mention).join(" ");

function duration(minutes: number): string {
  if (minutes % 1440 === 0) return `${minutes / 1440} d`;
  if (minutes % 60 === 0) return `${minutes / 60} h`;
  return `${minutes} min`;
}

function remember(message: Message): void {
  if (authors.size >= AUTHORS_MAX) {
    const oldest = authors.keys().next().value;
    if (oldest !== undefined) authors.delete(oldest);
  }
  authors.set(message.id, { id: message.author.id, name: message.author.username });
}

export default definePlugin({
  events: {
    async memberJoin(ctx, member) {
      if (!ctx.config.events.joins || (ctx.config.ignoreBots && member.user.bot)) return;
      const created = snowflakeTime(member.id);
      const fresh = Date.now() - created < 7 * 86_400_000 ? " ⚠️ new account" : "";
      await record(ctx, {
        group: "members",
        icon: "📥",
        text: `${member.mention} **${esc(member.user.username)}** joined · account created ${ts(created)}${fresh}`,
      });
    },

    async memberLeave(ctx, user) {
      if (!ctx.config.events.leaves || (ctx.config.ignoreBots && user.bot)) return;
      await record(ctx, {
        group: "members",
        icon: "📤",
        text: `${user.mention} **${esc(user.username)}** left (or was kicked or banned)`,
      });
    },

    async memberUpdate(ctx, member, previous) {
      if (!previous || (ctx.config.ignoreBots && member.user.bot)) return;
      const { roles, nicknames } = ctx.config.events;
      const who = `${member.mention} **${esc(member.user.username)}**`;
      if (nicknames && (previous.nickname ?? null) !== (member.nickname ?? null)) {
        const before = previous.nickname ? esc(previous.nickname) : "—";
        const after = member.nickname ? esc(member.nickname) : "—";
        await record(ctx, {
          group: "members",
          icon: "🏷️",
          text: `${who} nickname: ${before} → ${after}`,
        });
      }
      if (!roles) return;
      const before = new Set(previous.roles.map((r) => r.id));
      const after = new Set(member.roles.map((r) => r.id));
      const added = member.roles.filter((r) => !before.has(r.id));
      const removed = previous.roles.filter((r) => !after.has(r.id));
      const parts: string[] = [];
      if (added.length > 0) parts.push(`+ ${roleList(added)}`);
      if (removed.length > 0) parts.push(`− ${roleList(removed)}`);
      if (parts.length > 0)
        await record(ctx, {
          group: "members",
          icon: "🎭",
          text: `${who} roles: ${parts.join(" ")}`,
        });
    },

    // Only to know who wrote a message that gets deleted later (no content is read).
    messageCreate(ctx, message) {
      if (!ctx.config.events.messageDeletes || !message.author?.id) return;
      if (ctx.config.ignoreBots && message.author.bot) return;
      remember(message);
    },

    async messageUpdate(ctx, message) {
      // Partial updates (link previews) may come without an author.
      if (!ctx.config.events.messageEdits || !message.author?.id) return;
      if ((ctx.config.ignoreBots && message.author.bot) || ignored(ctx, message.channel)) return;
      const link = messageLink(ctx.server.id, message.channel.id, message.id);
      await record(ctx, {
        group: "messages",
        icon: "✏️",
        text: `${message.author.mention} edited [a message](${link}) in ${message.channel.mention}`,
      });
    },

    async messageDelete(ctx, { id, channel }) {
      if (!ctx.config.events.messageDeletes || ignored(ctx, channel)) return;
      const author = authors.get(id);
      authors.delete(id);
      // Unknown author: older than the plugin's memory, or a bot's (when bots are ignored).
      const by = author ? ` by <@${author.id}> **${esc(author.name)}**` : "";
      await record(ctx, {
        group: "messages",
        icon: "🗑️",
        text: `A message${by} was deleted in ${channel.mention} (sent ${ts(snowflakeTime(id))})`,
      });
    },
  },

  subscriptions: {
    /** Published by the moderation plugin for every case. */
    async "moderation.case"(ctx, payload) {
      if (!ctx.config.events.moderation) return;
      const c = (payload ?? {}) as ModerationCase;
      if (!c.action || !c.member?.id) return;
      const by = c.moderator ? ` by <@${c.moderator.id}>` : " (automatic)";
      const length = c.durationMinutes ? ` for ${duration(c.durationMinutes)}` : "";
      const number = c.number ? `case #${c.number} · ` : "";
      const reason = c.reason ? ` — ${esc(c.reason)}` : "";
      await record(ctx, {
        group: "plugins",
        icon: ACTION_ICONS[c.action] ?? "🛡️",
        text: `${number}**${esc(c.action)}** <@${c.member.id}> **${esc(c.member.name ?? "")}**${length}${by}${reason}`,
      });
    },

    /** Published by the polls plugin when a poll closes. */
    async "polls.closed"(ctx, payload) {
      if (!ctx.config.events.polls) return;
      const p = (payload ?? {}) as PollClosed;
      if (!p.pollId) return;
      const winners = p.winners?.length ? esc(p.winners.join(", ")) : "no votes";
      const voters = p.voters?.length ?? 0;
      const where =
        p.channelId && p.messageId
          ? ` [poll](${messageLink(ctx.server.id, p.channelId, p.messageId)})`
          : "";
      await record(ctx, {
        group: "plugins",
        icon: "📊",
        text: `Poll #${esc(p.pollId)} “${esc(p.question ?? "")}” closed: ${winners} (${voters} voter${voters === 1 ? "" : "s"})${where}`,
      });
    },
  },

  tasks: {
    /** Scheduled by the first entry of a batch. */
    async flush(ctx) {
      await flush(ctx);
    },
  },

  schedules: {
    /** Safety net: posts a batch whose flush task was lost (e.g. a crash at the wrong time). */
    sweep: {
      cron: "@every 1m",
      async run(ctx) {
        if (ctx.config.batchSeconds > 0) await flush(ctx, (ctx.config.batchSeconds + 60) * 1000);
      },
    },
  },
});
