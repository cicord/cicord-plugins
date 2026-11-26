import {
  command,
  subcommand,
  definePlugin,
  type Context,
  type ScheduledEvent,
  type ScheduledEventInput,
  type Json,
} from "@cicord/sdk";
import { ics, type CalendarItem } from "./calendar.ts";
const MIN = 60000,
  WEEK = 7 * 86400000;
type RecordEvent = CalendarItem & {
  channel?: string;
  series?: string;
  slot?: number;
  started?: boolean;
  ended?: boolean;
  fingerprint?: string;
};
async function records(ctx: Context) {
  const rows: RecordEvent[] = [];
  let cursor: string | undefined;
  do {
    const page = await ctx.kv.list<RecordEvent>({ prefix: "event:", cursor, limit: 500 });
    rows.push(...page.items.map((x) => x.value));
    cursor = page.cursor;
  } while (cursor);
  return rows;
}
const store = (ctx: Context, row: RecordEvent) => ctx.kv.set("event:" + row.id, row);
const snapshot = (e: ScheduledEvent): RecordEvent => ({
  id: e.id,
  name: e.name,
  start: e.start,
  ...(e.end ? { end: e.end } : {}),
  ...(e.channel ? { channel: e.channel } : {}),
  ...(e.location ? { location: e.location } : {}),
  ...(e.description ? { description: e.description } : {}),
});
async function reconcile(ctx: Context) {
  const now = Date.now(),
    native = await ctx.server.scheduledEvents(),
    rows = await records(ctx),
    desired = new Set<string>();
  for (const s of ctx.config.series) {
    const anchor = Date.parse(s.start);
    if (!Number.isFinite(anchor)) throw new Error("Invalid series start: " + s.key);
    for (let slot = Math.max(0, Math.ceil((now - anchor) / WEEK)); ; slot++) {
      const at = anchor + slot * WEEK;
      if (at >= now + ctx.config.weeksAhead * WEEK) break;
      const key = s.key + ":" + slot;
      desired.add(key);
      const marker = `[cicord:${ctx.bot.key}/${ctx.plugin.instance}/${key}]`;
      const input: ScheduledEventInput = {
        name: s.name,
        description: [s.description, marker].filter(Boolean).join("\n"),
        start: new Date(at).toISOString(),
        end: new Date(at + s.durationMinutes * MIN).toISOString(),
        ...(s.channel
          ? { channel: ctx.server.channel(s.channel).id }
          : { location: s.location ?? "Community" }),
      };
      const old = rows.find((e) => e.series === s.key && e.slot === slot);
      const found = native.find((e) => e.id === old?.id || e.description?.endsWith(marker));
      const fingerprint = JSON.stringify(input);
      if (old && found && old.fingerprint === fingerprint) continue;
      const event = found
        ? old
          ? await found.edit(input)
          : found
        : await ctx.server.createScheduledEvent(input);
      await store(ctx, {
        ...snapshot(event),
        description: s.description ?? "",
        series: s.key,
        slot,
        fingerprint,
      });
    }
  }
  for (const old of rows) {
    if (old.series && Date.parse(old.start) > now && !desired.has(old.series + ":" + old.slot)) {
      const e = native.find((e) => e.id === old.id);
      if (e) await e.delete();
      await ctx.kv.delete("event:" + old.id);
    }
  }
}
async function one(ctx: Context, key: string, work: () => Promise<void>) {
  if (await ctx.kv.get(key)) return;
  await work();
  await ctx.kv.set(key, true);
}
async function reminders(ctx: Context, r: RecordEvent, event: ScheduledEvent, phase: string) {
  let after: string | undefined;
  for (;;) {
    const users = await event.users(after);
    for (const id of users) {
      if (!(await ctx.kv.get("opt:" + id))) continue;
      await one(ctx, `sent:${id}:${r.id}:${phase}`, async () => {
        const m = await ctx.server.member(id);
        if (m) await m.send(ctx.i18n.t(phase === "hour" ? "hour" : "starting", { name: r.name }));
      });
    }
    if (users.length < 100) return;
    after = users[users.length - 1];
  }
}
async function tick(ctx: Context) {
  const now = Date.now(),
    native = await ctx.server.scheduledEvents();
  for (const r of await records(ctx)) {
    if (r.ended) continue;
    const start = Date.parse(r.start),
      end = r.end ? Date.parse(r.end) : Infinity,
      event = native.find((e) => e.id === r.id);
    if (now < start) {
      if (event && now >= start - 60 * MIN) await reminders(ctx, r, event, "hour");
      continue;
    }
    if (now < end && event?.status !== "completed" && event?.status !== "canceled") {
      if (!r.started) {
        if (ctx.config.announcementChannel)
          await one(ctx, "announced:" + r.id, async () => {
            const role = ctx.config.role ? ctx.server.role(ctx.config.role) : undefined;
            await ctx.server.channel(ctx.config.announcementChannel!).send({
              content: ctx.i18n.t("starting", { name: (role ? role.mention + " " : "") + r.name }),
              allowedMentions: { roles: role ? [role.id] : [], users: [], everyone: false },
            });
          });
        await ctx.events.publish(
          "started",
          { eventId: r.id, ...(r.channel ? { channelId: r.channel } : {}) },
          { version: 1, idempotencyKey: "start:" + r.id },
        );
        r.started = true;
        await store(ctx, r);
      }
      if (event) await reminders(ctx, r, event, "start");
      if (r.channel) {
        const minute = Math.floor(now / MIN);
        for (const m of await ctx.server.voiceMembers({ id: r.channel })) {
          if (m.user.bot) continue;
          const key = `attendance:${r.id}:${m.id}`;
          const prev = await ctx.kv.get<{ last: number; minutes: number }>(key);
          if (prev?.last !== minute)
            await ctx.kv.set(key, {
              last: minute,
              minutes: (prev?.minutes ?? 0) + (prev?.last === minute - 1 ? 1 : 0),
            });
        }
      }
    } else {
      const attendees: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await ctx.kv.list<{ minutes: number }>({
          prefix: "attendance:" + r.id + ":",
          limit: 1000,
          cursor,
        });
        for (const { key, value } of page.items) {
          if (value.minutes >= ctx.config.minMinutes) attendees.push(key.split(":")[2]!);
        }
        cursor = page.cursor;
      } while (cursor);
      await ctx.events.publish(
        "ended",
        { eventId: r.id, ...(r.channel ? { channelId: r.channel } : {}), attendees },
        { version: 1, idempotencyKey: "end:" + r.id },
      );
      await store(ctx, { ...r, ended: true });
    }
  }
}
function seriesItems(ctx: Context): CalendarItem[] {
  return ctx.config.series
    .filter((s) => !s.channel || ctx.server.audience(s.channel).public)
    .map((s) => ({
      id: "series-" + s.key,
      name: s.name,
      start: s.start,
      end: new Date(Date.parse(s.start) + s.durationMinutes * MIN).toISOString(),
      weekly: true,
      description: s.description,
      location: s.location,
    }));
}
async function privateData(ctx: Context, id: string, erase: boolean) {
  const found: Json[] = [];
  for (const prefix of ["opt:", "attendance:", "sent:"]) {
    let cursor: string | undefined;
    do {
      const page = await ctx.kv.list({ prefix, cursor, limit: 1000 });
      for (const { key, value } of page.items) {
        const parts = key.split(":");
        if (parts[prefix === "attendance:" ? 2 : 1] !== id) continue;
        found.push({ key, value });
        if (erase) await ctx.kv.delete(key);
      }
      cursor = page.cursor;
    } while (cursor);
  }
  return found;
}
export default definePlugin({
  async onStart(ctx) {
    await reconcile(ctx);
  },
  events: {
    async scheduledEventUpdate(ctx, event) {
      const old = await ctx.kv.get<RecordEvent>("event:" + event.id);
      if (!old) return;
      await store(ctx, { ...old, ...snapshot(event) });
      if (event.status === "active" || event.status === "completed") await tick(ctx);
    },
    async scheduledEventDelete(ctx, event) {
      await ctx.kv.delete("event:" + event.id);
    },
  },
  schedules: {
    horizon: { cron: "8 * * * *", run: reconcile },
    attendance: { cron: "* * * * *", run: tick },
  },
  commands: {
    event: command({
      description: "Community events",
      subcommands: {
        create: subcommand({
          description: "Create a scheduled community event",
          async run(ctx, it) {
            if (!it.member || it.member.access === "member") {
              await it.reply({ content: ctx.i18n.t("staff"), ephemeral: true });
              return;
            }
            await it.showModal({
              id: "create",
              title: ctx.i18n.t("modal"),
              fields: [
                { id: "name", label: ctx.i18n.t("name"), style: "short", required: true },
                { id: "start", label: ctx.i18n.t("start"), style: "short", required: true },
                { id: "end", label: ctx.i18n.t("end"), style: "short", required: true },
                { id: "location", label: ctx.i18n.t("location"), style: "short", required: true },
              ],
            });
          },
        }),
        reminders: subcommand({
          description: "Opt in or out of DMs for events you mark Interested",
          options: {
            enabled: { type: "boolean", required: true, description: "Receive reminder DMs" },
          },
          async run(ctx, it) {
            if (it.options.enabled) await ctx.kv.set("opt:" + it.user.id, true);
            else await ctx.kv.delete("opt:" + it.user.id);
            await it.reply({
              content: it.options.enabled ? ctx.i18n.t("optin") : ctx.i18n.t("optout"),
              ephemeral: true,
            });
          },
        }),
      },
    }),
  },
  modals: {
    async create(ctx, it) {
      if (!it.member || it.member.access === "member") {
        await it.reply({ content: ctx.i18n.t("staff"), ephemeral: true });
        return;
      }
      const f = it.fields,
        start = Date.parse(f.start ?? ""),
        end = Date.parse(f.end ?? "");
      if (!f.name || !f.location || !(start > Date.now() && end > start)) {
        await it.reply({
          content: ctx.i18n.t("invalid"),
          ephemeral: true,
        });
        return;
      }
      const e = await ctx.server.createScheduledEvent({
        name: f.name,
        location: f.location,
        start: new Date(start).toISOString(),
        end: new Date(end).toISOString(),
      });
      await store(ctx, snapshot(e));
      await it.reply({ content: ctx.i18n.t("created"), ephemeral: true });
    },
  },
  routes: {
    "GET /calendar": {
      access: "public",
      async handler(ctx) {
        return (await records(ctx))
          .filter((e) => !e.channel || ctx.server.audience({ id: e.channel }).public)
          .map(({ id, name, start, end }) => ({
            id,
            name,
            start,
            ...(end ? { end } : {}),
          }));
      },
    },
    "GET /calendar.ics": {
      access: "public",
      async handler(ctx) {
        const items = [
          ...seriesItems(ctx),
          ...(await records(ctx)).filter(
            (e) => !e.series && (!e.channel || ctx.server.audience({ id: e.channel }).public),
          ),
        ];
        return {
          status: 200,
          contentType: "text/calendar",
          raw: ics(
            items,
            [ctx.server.id, ctx.bot.key, ctx.plugin.instance].join("."),
            new Date().toISOString(),
          ),
        };
      },
    },
  },
  privacy: {
    export: (ctx, id) => privateData(ctx, id, false),
    async erase(ctx, id) {
      return { erased: (await privateData(ctx, id, true)).length };
    },
  },
});
