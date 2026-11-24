import {
  command,
  definePlugin,
  type Context,
  type Json,
  type RouteResponse,
  type TextChannel,
} from "@cicord/sdk";
import {
  adKey,
  draftKey,
  firedKey,
  parseWhen,
  preview,
  renderConfigured,
  renderScheduled,
  type Configured,
  type Draft,
  type Mentions,
  type Scheduled,
} from "./messages.ts";
import { dueIn, nextRun, parseSchedule, type Schedule } from "./schedule.ts";
import { toLocal, toUtc } from "./tz.ts";

const MINUTE = 60_000;
const MAX_DAYS = 90;
const TICK = "tick:last";
const POSTABLE: ReadonlySet<string> = new Set(["text", "announcement", "thread"]);

const zoneOf = (ctx: Context, a?: Configured): string => a?.timeZone ?? ctx.config.timeZone;
const at = (ms: number, style = "F"): string => `<t:${Math.floor(ms / 1000)}:${style}>`;

/** The schedule of a configured announcement, or why it is invalid. */
function scheduleOf(a: Configured): Schedule | string {
  try {
    return parseSchedule(a);
  } catch (error) {
    return (error as Error).message;
  }
}

async function scheduledList(ctx: Context): Promise<Scheduled[]> {
  const { items } = await ctx.kv.list({ prefix: "ad:", limit: 1000 });
  return items.map((i) => i.value as unknown as Scheduled).toSorted((a, b) => a.at - b.at);
}

/** Posts a configured announcement. Failures are logged (the tick never throws). */
async function postConfigured(ctx: Context, a: Configured): Promise<void> {
  const message = renderConfigured(ctx, a);
  if (!message) {
    ctx.log.warn("announcements: nothing to post (set content or embed)", { announcement: a.name });
    return;
  }
  try {
    await ctx.server.channel(a.channel).send(message);
    await ctx.kv.increment("stats:posted");
    ctx.log.info("announcement posted", { announcement: a.name });
  } catch (error) {
    ctx.log.error("announcements: could not post", { announcement: a.name, error: String(error) });
  }
}

/** Resolves the channel of /announce: a text channel the config allows. */
function postableChannel(ctx: Context, id: string): TextChannel | string {
  let channel: TextChannel;
  try {
    channel = ctx.server.channel({ id });
  } catch {
    return "I can't find that channel.";
  }
  if (!POSTABLE.has(channel.type)) return `${channel.mention} is not a text channel.`;
  const allowed = ctx.config.channels.map((key) => {
    try {
      return ctx.server.channel(key).id;
    } catch {
      return "";
    }
  });
  if (allowed.length > 0 && !allowed.includes(channel.id))
    return `Announcements can be posted in ${allowed
      .filter(Boolean)
      .map((c) => `<#${c}>`)
      .join(", ")}.`;
  return channel;
}

function describeRecurring(ctx: Context, now: number): string[] {
  const nowMin = Math.floor(now / MINUTE);
  return ctx.config.announcements.map((a) => {
    const s = scheduleOf(a);
    const where = (() => {
      try {
        return ctx.server.channel(a.channel).mention;
      } catch {
        return `#${a.channel}`;
      }
    })();
    if (typeof s === "string") return `⚠️ **${a.name}** (${where}): ${s}`;
    if (!a.enabled) return `⏸️ **${a.name}** (${where}): ${s.text}, disabled`;
    const next = nextRun(s, zoneOf(ctx, a), nowMin);
    const when = next === undefined ? "no next run" : `next ${at(next * MINUTE)}`;
    return `🔁 **${a.name}** (${where}): ${s.text} (${zoneOf(ctx, a)}), ${when}`;
  });
}

export default definePlugin({
  schedules: {
    /**
     * Every minute: posts the configured announcements due since the last tick (at most
     * `catchUpMinutes` back, once each, even across restarts and DST changes).
     */
    tick: {
      cron: "* * * * *",
      async run(ctx) {
        const nowMin = Math.floor(Date.now() / MINUTE);
        const last = (await ctx.kv.get<number>(TICK)) ?? nowMin - 1;
        const from = Math.max(last + 1, nowMin - ctx.config.catchUpMinutes);
        await ctx.kv.set(TICK, nowMin);
        if (from > nowMin) return;
        for (const a of ctx.config.announcements) {
          if (!a.enabled) continue;
          const s = scheduleOf(a);
          if (typeof s === "string") continue; // reported by /announce-list
          const fired = await ctx.kv.get<number>(firedKey(a.name));
          const due = dueIn(s, zoneOf(ctx, a), from, nowMin, fired);
          if (due === undefined) continue;
          await ctx.kv.set(firedKey(a.name), due);
          await postConfigured(ctx, a);
        }
      },
    },
  },

  tasks: {
    /** Posts an /announce message (unless it was cancelled). */
    async post(ctx, payload) {
      const id = Number((payload as { id?: number } | undefined)?.id);
      const s = (await ctx.kv.get(adKey(id))) as unknown as Scheduled | undefined;
      if (!s) return;
      await ctx.kv.delete(adKey(id));
      try {
        await ctx.server.channel({ id: s.channelId }).send(renderScheduled(ctx, s));
        await ctx.kv.increment("stats:posted");
        ctx.log.info("scheduled announcement posted", { id, by: s.by.id });
      } catch (error) {
        ctx.log.error("announcements: could not post a scheduled announcement", {
          id,
          channel: s.channelId,
          error: String(error),
        });
      }
    },
  },

  commands: {
    announce: command({
      description: "Post or schedule an announcement (opens a form for the text)",
      ephemeral: true,
      permissions: ["ManageMessages"],
      options: {
        channel: { type: "channel", description: "Where to post it", required: true },
        when: {
          type: "string",
          description: 'now (default), "in 2h", "18:30" or "2026-12-24 18:00" (server time zone)',
        },
        mention: { type: "mentionable", description: "Role or member to ping" },
        everyone: { type: "boolean", description: "Ping @everyone (if the config allows it)" },
      },
      async run(ctx, interaction) {
        const o = interaction.options;
        const channel = postableChannel(ctx, o.channel.id);
        if (typeof channel === "string") {
          await interaction.reply(channel);
          return;
        }
        if (o.everyone && !ctx.config.allowEveryone) {
          await interaction.reply("@everyone is turned off for announcements (allowEveryone).");
          return;
        }
        const now = Date.now();
        const zone = ctx.config.timeZone;
        const when = parseWhen(
          o.when ?? "",
          now,
          toLocal(zone, Math.floor(now / MINUTE)),
          (local) => toUtc(zone, local) * MINUTE,
        );
        if (typeof when === "string") {
          await interaction.reply(when);
          return;
        }
        if (when < now - MINUTE) {
          await interaction.reply(`${at(when)} is in the past.`);
          return;
        }
        if (when > now + MAX_DAYS * 86_400_000) {
          await interaction.reply(`Announcements can be scheduled up to ${MAX_DAYS} days ahead.`);
          return;
        }
        if (when > now + MINUTE && (await scheduledList(ctx)).length >= ctx.config.maxScheduled) {
          await interaction.reply(
            `${ctx.config.maxScheduled} announcements are already scheduled: cancel one first (/announce-cancel).`,
          );
          return;
        }
        const m = o.mention;
        const mentions: Mentions = {
          roles: m && "name" in m && !("username" in m) ? [m.id] : [],
          ...(m && "username" in m ? { user: m.id } : {}),
          ...(o.everyone ? { everyone: true } : {}),
        };
        const n = await ctx.kv.increment("draft-seq");
        const draft: Draft = { channelId: channel.id, at: when, mentions };
        await ctx.kv.set(draftKey(n), draft as unknown as Json, { ttlSeconds: 900 });
        await interaction.showModal({
          id: `compose:${n}`,
          title: "Announcement",
          fields: [
            {
              id: "title",
              label: "Title (optional)",
              style: "short",
              required: false,
              maxLength: 256,
            },
            {
              id: "message",
              label: "Message",
              style: "paragraph",
              required: true,
              maxLength: 4000,
            },
          ],
        });
      },
    }),

    "announce-list": command({
      description: "Scheduled and recurring announcements",
      ephemeral: true,
      permissions: ["ManageMessages"],
      async run(ctx, interaction) {
        const now = Date.now();
        const recurring = describeRecurring(ctx, now);
        const scheduled = (await scheduledList(ctx)).map(
          (s) =>
            `🗓️ **#${s.id}** <#${s.channelId}> ${at(s.at)} (${at(s.at, "R")}) by <@${s.by.id}>: ${preview(s.title ?? s.body)}`,
        );
        if (recurring.length + scheduled.length === 0) {
          await interaction.reply("No announcements: use /announce, or add some to the config.");
          return;
        }
        const sections: string[] = [];
        if (scheduled.length > 0)
          sections.push(`**Scheduled** (/announce-cancel to cancel)\n${scheduled.join("\n")}`);
        if (recurring.length > 0) sections.push(`**From the config**\n${recurring.join("\n")}`);
        let text = sections.join("\n\n");
        if (text.length > 4000) text = `${text.slice(0, 3990)}…`;
        await interaction.reply({
          embeds: [{ title: "Announcements", description: text, color: ctx.config.color }],
          allowedMentions: { users: false, roles: false, everyone: false },
        });
      },
    }),

    "announce-cancel": command({
      description: "Cancel a scheduled announcement",
      ephemeral: true,
      permissions: ["ManageMessages"],
      options: {
        id: {
          type: "integer",
          description: "Its number (see /announce-list)",
          required: true,
          min: 1,
        },
      },
      async run(ctx, interaction) {
        const id = interaction.options.id;
        const s = (await ctx.kv.get(adKey(id))) as unknown as Scheduled | undefined;
        if (!s) {
          await interaction.reply(
            `No scheduled announcement #${id}. Announcements from the config are changed in the config.`,
          );
          return;
        }
        if (s.taskId) await ctx.schedule.cancel(s.taskId);
        await ctx.kv.delete(adKey(id));
        ctx.log.info("scheduled announcement cancelled", { id, by: interaction.user.id });
        await interaction.reply(
          `Announcement #${id} (${at(s.at)} in <#${s.channelId}>) is cancelled.`,
        );
      },
    }),
  },

  modals: {
    /** The /announce form: posts now or schedules the task. */
    async compose(ctx, interaction) {
      const n = Number(interaction.modalId.split(":")[1]);
      const draft = (await ctx.kv.get(draftKey(n))) as unknown as Draft | undefined;
      if (!draft) {
        await interaction.reply({
          content: "This form expired: run /announce again.",
          ephemeral: true,
        });
        return;
      }
      await ctx.kv.delete(draftKey(n));
      const body = (interaction.fields["message"] ?? "").trim();
      const title = (interaction.fields["title"] ?? "").trim();
      if (!body) {
        await interaction.reply({ content: "The message is empty.", ephemeral: true });
        return;
      }
      const s: Scheduled = {
        id: await ctx.kv.increment("seq"),
        channelId: draft.channelId,
        at: draft.at,
        ...(title ? { title } : {}),
        body,
        mentions: draft.mentions,
        by: {
          id: interaction.user.id,
          name: interaction.member?.displayName ?? interaction.user.displayName,
        },
        createdAt: new Date().toISOString(),
      };
      const delay = s.at - Date.now();
      if (delay <= MINUTE) {
        await ctx.server.channel({ id: s.channelId }).send(renderScheduled(ctx, s));
        await ctx.kv.increment("stats:posted");
        await interaction.reply({ content: `Posted in <#${s.channelId}>.`, ephemeral: true });
        return;
      }
      s.taskId = (await ctx.schedule.after(delay, "post", { id: s.id })).id;
      await ctx.kv.set(adKey(s.id), s as unknown as Json);
      ctx.log.info("announcement scheduled", { id: s.id, at: new Date(s.at).toISOString() });
      await interaction.reply({
        content: `Announcement #${s.id} is scheduled for ${at(s.at)} (${at(s.at, "R")}) in <#${s.channelId}>.`,
        ephemeral: true,
      });
    },
  },

  routes: {
    /** Recurring and scheduled announcements (staff portal). */
    "GET /scheduled": {
      access: "moderator",
      async handler(ctx): Promise<RouteResponse> {
        const nowMin = Math.floor(Date.now() / MINUTE);
        const recurring = ctx.config.announcements.map((a) => {
          const s = scheduleOf(a);
          const next =
            typeof s === "string" || !a.enabled ? undefined : nextRun(s, zoneOf(ctx, a), nowMin);
          return {
            name: a.name,
            channel: a.channel,
            enabled: a.enabled,
            timeZone: zoneOf(ctx, a),
            schedule: typeof s === "string" ? null : s.text,
            error: typeof s === "string" ? s : null,
            next: next === undefined ? null : new Date(next * MINUTE).toISOString(),
          };
        });
        const scheduled = (await scheduledList(ctx)).map((s) => ({
          id: s.id,
          channelId: s.channelId,
          at: new Date(s.at).toISOString(),
          title: s.title ?? null,
          preview: preview(s.body, 120),
          by: s.by,
        }));
        return { timeZone: ctx.config.timeZone, recurring, scheduled };
      },
    },
  },
});
