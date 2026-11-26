import {
  command,
  definePlugin,
  type Context,
  type Json,
  type Member,
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

import { post } from "./delivery.ts";
import {
  countdownCommand,
  countdown,
  countPosts,
  sticky,
  send,
  portalCompose,
} from "./community.ts";

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
function occurrenceNonce(value: string) {
  let hash = 14695981039346656037n;
  for (const ch of value)
    hash = BigInt.asUintN(64, (hash ^ BigInt(ch.codePointAt(0)!)) * 1099511628211n);
  return "cfg" + hash.toString(36);
}

async function postConfigured(ctx: Context, a: Configured, due: number): Promise<void> {
  const message = renderConfigured(ctx, a);
  if (!message) {
    ctx.log.warn("announcements: nothing to post (set content or embed)", { announcement: a.name });
    return;
  }
  const channel = ctx.server.channel(a.channel);
  const nonce = occurrenceNonce(ctx.plugin.instance + "|" + a.name + "|" + due);
  await send(ctx, channel, { ...message, nonce, enforceNonce: true });
  await ctx.kv.increment("stats:posted");
  ctx.log.info("announcement posted", { announcement: a.name });
}

/** Resolves the channel of /announce: a text channel the config allows. */
function postableChannel(ctx: Context, id: string): TextChannel | string {
  let channel: TextChannel;
  try {
    channel = ctx.server.channel({ id });
  } catch {
    return ctx.i18n.t("noChannel");
  }
  if (!POSTABLE.has(channel.type)) return ctx.i18n.t("notText", { channel: channel.mention });
  const allowed = ctx.config.channels.map((key) => {
    try {
      return ctx.server.channel(key).id;
    } catch {
      return "";
    }
  });
  if (allowed.length > 0 && !allowed.includes(channel.id))
    return ctx.i18n.t("allowed", {
      channels: allowed
        .filter(Boolean)
        .map((c) => `<#${c}>`)
        .join(", "),
    });
  return channel;
}

function visible(member: Member | undefined, channel: string, byID = false) {
  try {
    return !!member?.canView(byID ? { id: channel } : channel);
  } catch {
    return false;
  }
}

function describeRecurring(ctx: Context, now: number, member: Member | undefined): string[] {
  const nowMin = Math.floor(now / MINUTE);
  return ctx.config.announcements
    .filter((a) => visible(member, a.channel))
    .map((a) => {
      const s = scheduleOf(a);
      const where = (() => {
        try {
          return ctx.server.channel(a.channel).mention;
        } catch {
          return `#${a.channel}`;
        }
      })();
      if (typeof s === "string")
        return `⚠️ **${a.name}** (${where}): ${a.cron ? ctx.i18n.t("cronInvalid", { cron: a.cron }) : ctx.i18n.t("scheduleInvalid")}`;
      const label =
        s.kind === "every"
          ? ctx.i18n.t("every", { interval: a.every ?? "" }) +
            (a.start ? ctx.i18n.t("from", { date: a.start }) : "")
          : s.kind === "at"
            ? ctx.i18n.t("once", { date: a.at ?? "" })
            : s.text;
      if (!a.enabled) return `⏸️ **${a.name}** (${where}): ${label}, ${ctx.i18n.t("paused")}`;
      const next = nextRun(s, zoneOf(ctx, a), nowMin);
      const when =
        next === undefined ? ctx.i18n.t("noNext") : ctx.i18n.t("next", { when: at(next * MINUTE) });
      return `🔁 **${a.name}** (${where}): ${label} (${zoneOf(ctx, a)}), ${when}`;
    });
}

async function authored(ctx: Context, id: string, erase: boolean) {
  const rows: Json[] = [];
  for (const prefix of ["ad:", "draft:"]) {
    let cursor: string | undefined;
    do {
      const page = await ctx.kv.list({ prefix, limit: 100, cursor });
      for (const item of page.items) {
        const row = item.value as unknown as Scheduled & Draft;
        if (row.by?.id !== id && row.owner !== id && row.mentions?.user !== id) continue;
        if (row.by?.id === id || row.owner === id) {
          rows.push(item.value);
          if (erase) {
            if (row.taskId) await ctx.schedule.cancel(row.taskId);
            await ctx.kv.delete(item.key);
          }
        } else {
          rows.push({ mention: id });
          if (erase) {
            delete row.mentions.user;
            await ctx.kv.set(
              item.key,
              row as unknown as Json,
              prefix === "draft:" ? { ttlSeconds: 900 } : undefined,
            );
          }
        }
      }
      cursor = page.cursor;
    } while (cursor);
  }
  return rows;
}

export default definePlugin({
  async onStart(ctx) {
    await ctx.kv.set("meta:schema", 1);
  },
  events: { messageCreate: countPosts },
  schedules: {
    /**
     * Every minute: posts the configured announcements due since the last tick (at most
     * `catchUpMinutes` back, once each, even across restarts and DST changes).
     */
    tick: {
      cron: "* * * * *",
      async run(ctx) {
        if (ctx.config.enabled === false) return;
        const nowMin = Math.floor(Date.now() / MINUTE);
        const last = (await ctx.kv.get<number>(TICK)) ?? nowMin - 1;
        const from = Math.max(last + 1, nowMin - ctx.config.catchUpMinutes);
        if (from > nowMin) return;
        for (const a of ctx.config.announcements) {
          if (!a.enabled) continue;
          const s = scheduleOf(a);
          if (typeof s === "string") continue; // reported by /announce-list
          const fired = await ctx.kv.get<number>(firedKey(a.name));
          const due = dueIn(s, zoneOf(ctx, a), from, nowMin, fired);
          if (due === undefined) continue;
          await postConfigured(ctx, a, due);
          await ctx.kv.set(firedKey(a.name), due);
        }
        await ctx.kv.set(TICK, nowMin);
      },
    },
  },

  tasks: { countdown, sticky, post },

  commands: {
    countdown: countdownCommand,
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
        if (ctx.config.enabled === false) return interaction.reply(ctx.i18n.t("disabled"));
        const o = interaction.options;
        const channel = postableChannel(ctx, o.channel.id);
        if (typeof channel === "string") {
          await interaction.reply(channel);
          return;
        }
        if (!visible(interaction.member, channel.id, true))
          return interaction.reply(ctx.i18n.t("noChannel"));
        if (o.everyone && !ctx.config.allowEveryone) {
          await interaction.reply(ctx.i18n.t("noEveryone"));
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
          await interaction.reply(ctx.i18n.t("badWhen", { text: o.when ?? "" }));
          return;
        }
        if (when < now - MINUTE) {
          await interaction.reply(ctx.i18n.t("past", { when: at(when) }));
          return;
        }
        if (when > now + MAX_DAYS * 86_400_000) {
          await interaction.reply(ctx.i18n.t("ahead", { days: MAX_DAYS }));
          return;
        }
        if (when > now + MINUTE && (await scheduledList(ctx)).length >= ctx.config.maxScheduled) {
          await interaction.reply(ctx.i18n.t("busy", { n: ctx.config.maxScheduled }));
          return;
        }
        const m = o.mention;
        const mentions: Mentions = {
          roles: m && "name" in m && !("username" in m) ? [m.id] : [],
          ...(m && "username" in m ? { user: m.id } : {}),
          ...(o.everyone ? { everyone: true } : {}),
        };
        const n = await ctx.kv.increment("draft-seq");
        const draft: Draft = {
          owner: interaction.user.id,
          channelId: channel.id,
          at: when,
          mentions,
        };
        await ctx.kv.set(draftKey(n), draft as unknown as Json, { ttlSeconds: 900 });
        await interaction.showModal({
          id: `compose:${n}`,
          title: ctx.i18n.t("title"),
          fields: [
            {
              id: "title",
              label: ctx.i18n.t("optionalTitle"),
              style: "short",
              required: false,
              maxLength: 256,
            },
            {
              id: "message",
              label: ctx.i18n.t("message"),
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
        const recurring = describeRecurring(ctx, now, interaction.member);
        const scheduled = (await scheduledList(ctx))
          .filter((s) => visible(interaction.member, s.channelId, true))
          .map(
            (s) =>
              `🗓️ **#${s.id}** <#${s.channelId}> ${at(s.at)} (${at(s.at, "R")}) ${ctx.i18n.t("by")} <@${s.by.id}>: ${preview(s.title ?? s.body)}`,
          );
        if (recurring.length + scheduled.length === 0) {
          await interaction.reply(ctx.i18n.t("noAds"));
          return;
        }
        const sections: string[] = [];
        if (scheduled.length > 0)
          sections.push(`${ctx.i18n.t("scheduledSection")}\n${scheduled.join("\n")}`);
        if (recurring.length > 0)
          sections.push(`${ctx.i18n.t("configSection")}\n${recurring.join("\n")}`);
        let text = sections.join("\n\n");
        if (text.length > 4000) text = `${text.slice(0, 3990)}…`;
        await interaction.reply({
          embeds: [{ title: ctx.i18n.t("list"), description: text, color: ctx.config.color }],
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
        if (!s || !visible(interaction.member, s.channelId, true)) {
          await interaction.reply(ctx.i18n.t("missing", { id }));
          return;
        }
        if (s.taskId) await ctx.schedule.cancel(s.taskId);
        await ctx.kv.delete(adKey(id));
        ctx.log.info("scheduled announcement cancelled", { id, by: interaction.user.id });
        await interaction.reply(
          ctx.i18n.t("cancel", { id, when: at(s.at), channel: `<#${s.channelId}>` }),
        );
      },
    }),
  },

  modals: {
    /** The /announce form: posts now or schedules the task. */
    async compose(ctx, interaction) {
      const n = Number(interaction.modalId.split(":")[1]);
      const draft = (await ctx.kv.get(draftKey(n))) as unknown as Draft | undefined;
      if (
        !draft ||
        (draft.owner && draft.owner !== interaction.user.id) ||
        !visible(interaction.member, draft.channelId, true)
      ) {
        await interaction.reply({
          content: ctx.i18n.t("expired"),
          ephemeral: true,
        });
        return;
      }
      await ctx.kv.delete(draftKey(n));
      const body = (interaction.fields["message"] ?? "").trim();
      const title = (interaction.fields["title"] ?? "").trim();
      if (!body) {
        await interaction.reply({ content: ctx.i18n.t("empty"), ephemeral: true });
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
        await send(ctx, ctx.server.channel({ id: s.channelId }), {
          ...renderScheduled(ctx, s),
          nonce: "a" + s.id,
          enforceNonce: true,
        });
        await ctx.kv.increment("stats:posted");
        await interaction.reply({
          content: ctx.i18n.t("posted", { channel: `<#${s.channelId}>` }),
          ephemeral: true,
        });
        return;
      }
      s.taskId = (await ctx.schedule.after(delay, "post", { id: s.id })).id;
      await ctx.kv.set(adKey(s.id), s as unknown as Json);
      ctx.log.info("announcement scheduled", { id: s.id, at: new Date(s.at).toISOString() });
      await interaction.reply({
        content: ctx.i18n.t("scheduled", {
          id: s.id,
          when: at(s.at),
          relative: at(s.at, "R"),
          channel: `<#${s.channelId}>`,
        }),
        ephemeral: true,
      });
    },
  },

  privacy: {
    export: (ctx, id) => authored(ctx, id, false).then((rows) => rows),
    async erase(ctx, id) {
      return { erased: (await authored(ctx, id, true)).length };
    },
  },
  routes: {
    "POST /preview": {
      access: "moderator",
      handler: (ctx, r) => portalCompose(ctx, r.viewer, r.body, true),
    },
    "POST /compose": {
      access: "moderator",
      handler: (ctx, r) => portalCompose(ctx, r.viewer, r.body, false),
    },
    /** Recurring and scheduled announcements (staff portal). */
    "GET /scheduled": {
      access: "moderator",
      async handler(ctx, req): Promise<RouteResponse> {
        const nowMin = Math.floor(Date.now() / MINUTE);
        const recurring = ctx.config.announcements
          .filter((a) => visible(req.viewer?.member, a.channel))
          .map((a) => {
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
        const scheduled = (await scheduledList(ctx))
          .filter((s) => visible(req.viewer?.member, s.channelId, true))
          .map((s) => ({
            id: s.id,
            channelId: s.channelId,
            at: new Date(s.at).toISOString(),
            title: s.title ?? null,
            preview: preview(s.body, 120),
            by: s.by,
          }));
        const issues = (await ctx.kv.list({ prefix: "crosspost:", limit: 100 })).items
          .filter((row) => visible(req.viewer?.member, row.key.slice(10), true))
          .map((row) => ({
            code: "crosspost_refused",
            channel: row.key.slice(10),
            details: row.value,
          }));
        return { timeZone: ctx.config.timeZone, recurring, scheduled, issues };
      },
    },
  },
});
