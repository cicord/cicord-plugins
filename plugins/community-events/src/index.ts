import {
  command,
  subcommand,
  definePlugin,
  type Context,
  type ScheduledEvent,
  type ScheduledEventInput,
  type Json,
} from "@cicord/sdk";
import { sendOnce, receiptTTL } from "./delivery.ts";
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
async function store(ctx: Context, row: RecordEvent) {
  const batch = ctx.kv.atomic().set("event:" + row.id, row);
  if (row.ended) batch.delete("active:" + row.id);
  else batch.set("active:" + row.id, true);
  await batch.commit();
}
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
      await ctx.kv
        .atomic()
        .delete("event:" + old.id)
        .delete("active:" + old.id)
        .commit();
    }
  }
}
type Phase = "hour" | "start";
type ReminderPage = { after: string; done: boolean };
type EventJob = { id: string; phase?: Phase; cursor?: string; minute?: number };
const eventRow = (ctx: Context, id: string) => ctx.kv.get<RecordEvent>("event:" + id);
const liveEvent = async (ctx: Context, id: string) =>
  (await ctx.server.scheduledEvents()).find((e) => e.id === id);
const enqueue = (ctx: Context, task: string, payload: EventJob) =>
  ctx.schedule.after(1, task, payload);
const phaseKey = (id: string, phase: Phase) => `phase:${id}:${phase}`;
function due(event: ScheduledEvent, phase: Phase) {
  const now = Date.now(),
    start = Date.parse(event.start);
  if (event.status === "canceled" || event.status === "completed") return false;
  return phase === "hour"
    ? now >= start - 60 * MIN && now < start
    : now >= start && (!event.end || now < Date.parse(event.end));
}
async function reminders(ctx: Context, id: string, phase: Phase) {
  const rec = await eventRow(ctx, id);
  if (!rec || rec.ended) return;
  const key = phaseKey(id, phase),
    page = await ctx.kv.getEntry<ReminderPage>(key);
  if (page?.value.done) return;
  const event = await liveEvent(ctx, id);
  if (!event || !due(event, phase)) return;
  // One Discord page per task, at most five member reads and sends per pass.
  const users = await event.users(page?.value.after || undefined);
  const opted = await ctx.kv.getMany<boolean>(users.map((user) => "opt:" + user));
  let index = 0,
    sends = 0;
  for (; index < users.length && sends < 5; index++) {
    const user = users[index]!;
    if (!opted[index]) continue;
    sends++;
    await sendOnce(
      ctx,
      `sent:${user}:${id}:${phase}`,
      async () => {
        if (!(await ctx.kv.get("opt:" + user))) return;
        const member = await ctx.server.member(user);
        if (!member || (event.channel && !member.canView({ id: event.channel }))) return;
        return member.send(
          {
            content: ctx.i18n.t(phase === "hour" ? "hour" : "starting", { name: event.name }),
            nonce: (phase === "hour" ? "h" : "s") + id,
            enforceNonce: true,
            allowedMentions: { roles: [], users: [], everyone: false },
          },
          { retractable: true },
        );
      },
      true,
    );
  }
  const done = index === users.length && users.length < 100;
  const after = users[index - 1] ?? page?.value.after ?? "";
  // The periodic inspection also re-enqueues unfinished pages after a crash.
  const progressed = await ctx.kv
    .atomic()
    .check(key, page?.version)
    .set(key, { after, done }, { ttlSeconds: receiptTTL })
    .commit();
  if (progressed.ok && !done) await enqueue(ctx, "remind", { id, phase });
}
async function announce(ctx: Context, event: ScheduledEvent) {
  if (!ctx.config.announcementChannel) return;
  await sendOnce(ctx, "announced:" + event.id, async () => {
    const destination = ctx.server.channel(ctx.config.announcementChannel!);
    if (event.channel) {
      const source = { id: event.channel };
      const relation = ctx.server.compareAudience(source, destination);
      if (relation !== "same" && relation !== "narrower") return;
    }
    const role = ctx.config.role ? ctx.server.role(ctx.config.role) : undefined;
    return destination.send({
      content: ctx.i18n.t("starting", { name: (role ? role.mention + " " : "") + event.name }),
      nonce: "a" + event.id,
      enforceNonce: true,
      allowedMentions: { roles: role ? [role.id] : [], users: [], everyone: false },
    });
  });
}
async function activePage(ctx: Context, cursor?: string) {
  const page = await ctx.kv.list({ prefix: "active:", cursor, limit: 20 });
  for (const item of page.items) await enqueue(ctx, "inspect", { id: item.key.slice(7) });
  if (page.cursor) await enqueue(ctx, "scan", { id: "", cursor: page.cursor });
}
async function sample(ctx: Context, r: RecordEvent, minute: number, after = "") {
  if (!r.channel || !r.started || r.ended || Math.floor(Date.now() / MIN) !== minute) return;
  const voice = (await ctx.server.voiceMembers({ id: r.channel })).filter(
    (m) =>
      !m.user.bot && (m.id.length > after.length || (m.id.length === after.length && m.id > after)),
  );
  const slice = voice.slice(0, 25);
  const keys = slice.map((m) => `attendance:${r.id}:${m.id}`);
  const rows = await Promise.all(
    keys.map((k) => ctx.kv.getEntry<{ last: number; minutes: number }>(k)),
  );
  const batch = ctx.kv.atomic();
  let writes = 0;
  for (let k = 0; k < rows.length; k++) {
    const entry = rows[k];
    if ((entry?.value.last ?? -1) >= minute) continue;
    batch
      .check(keys[k]!, entry?.version)
      .set(
        keys[k]!,
        {
          last: minute,
          minutes: (entry?.value.minutes ?? 0) + (entry?.value.last === minute - 1 ? 1 : 0),
        },
        { ttlSeconds: receiptTTL },
      );
    writes++;
  }
  if (writes && !(await batch.commit()).ok) throw new Error("Attendance sample changed");
  if (voice.length > slice.length)
    await enqueue(ctx, "sample", { id: r.id, minute, cursor: slice.at(-1)!.id });
}
async function inspect(ctx: Context, id: string) {
  const r = await eventRow(ctx, id);
  if (!r || r.ended) return;
  const now = Date.now(),
    start = Date.parse(r.start),
    end = r.end ? Date.parse(r.end) : Infinity;
  if (now < start - 60 * MIN) return;
  const event = await liveEvent(ctx, id);
  if (event && due(event, now < start ? "hour" : "start")) {
    const phase = now < start ? "hour" : "start";
    if (phase === "start") {
      if (!r.started) {
        await announce(ctx, event);
        await ctx.events.publish(
          "started",
          { eventId: id, ...(event.channel ? { channelId: event.channel } : {}) },
          { version: 1, idempotencyKey: "start:" + id },
        );
        await store(ctx, { ...r, started: true });
        r.started = true;
      }
      await sample(ctx, r, Math.floor(now / MIN));
    }
    if (!(await ctx.kv.get<ReminderPage>(phaseKey(id, phase)))?.done)
      await enqueue(ctx, "remind", { id, phase });
    return;
  }
  if (now < end && event && event.status !== "completed" && event.status !== "canceled") return;
  await enqueue(ctx, "finish", { id });
}
// Checkpoint one attendance page per job. The final publication requires one
// contract payload; pack only qualifying IDs into pages for that final read.
type EndScan = { cursor: string; chunks: number; tail: string[]; complete: boolean };
async function finish(ctx: Context, id: string) {
  const r = await eventRow(ctx, id);
  if (!r || r.ended) return;
  const key = "endScan:" + id,
    state = await ctx.kv.getEntry<EndScan>(key);
  const scan = state?.value ?? { cursor: "", chunks: 0, tail: [], complete: false };
  if (!scan.complete) {
    const page = await ctx.kv.list<{ minutes: number }>({
      prefix: "attendance:" + id + ":",
      limit: 500,
      cursor: scan.cursor || undefined,
    });
    const tail = [
      ...scan.tail,
      ...page.items
        .filter((x) => x.value.minutes >= ctx.config.minMinutes)
        .map((x) => x.key.split(":")[2]!),
    ];
    const batch = ctx.kv.atomic().check(key, state?.version);
    let chunks = scan.chunks;
    if (tail.length >= 1000)
      batch.set(`endChunk:${id}:${chunks++}`, tail.splice(0, 1000), { ttlSeconds: receiptTTL });
    const updated = await batch
      .set(
        key,
        { cursor: page.cursor ?? "", complete: !page.cursor, chunks, tail },
        { ttlSeconds: receiptTTL },
      )
      .commit();
    if (updated.ok) await enqueue(ctx, "finish", { id });
    return;
  }
  const attendees: string[] = [];
  for (let n = 0; n < scan.chunks; n += 32) {
    const count = Math.min(32, scan.chunks - n);
    const pages = await ctx.kv.getMany<string[]>(
      Array.from({ length: count }, (_, offset) => `endChunk:${id}:${n + offset}`),
    );
    for (const page of pages) {
      if (!page) throw new Error("Attendance checkpoint expired");
      attendees.push(...page);
    }
  }
  attendees.push(...scan.tail);
  await ctx.events.publish(
    "ended",
    { eventId: id, ...(r.channel ? { channelId: r.channel } : {}), attendees },
    { version: 1, idempotencyKey: "end:" + id },
  );
  await store(ctx, { ...r, ended: true });
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
        if (erase) {
          if (
            prefix === "sent:" &&
            value &&
            typeof value === "object" &&
            !Array.isArray(value) &&
            typeof value.messageId === "string"
          )
            await ctx.server.retractDM(value.messageId);
          await ctx.kv.delete(key);
        }
      }
      cursor = page.cursor;
    } while (cursor);
  }
  for (const prefix of ["endScan:", "endChunk:"]) {
    let cursor: string | undefined;
    do {
      const page = await ctx.kv.list<EndScan | string[]>({ prefix, cursor, limit: 50 });
      for (const { key, value } of page.items) {
        const ids = Array.isArray(value) ? value : value.tail;
        if (!ids.includes(id)) continue;
        found.push({ event: key.split(":")[1]!, attendance: true });
        if (erase) {
          const filtered = ids.filter((user) => user !== id);
          await ctx.kv.set(key, Array.isArray(value) ? filtered : { ...value, tail: filtered }, {
            ttlSeconds: receiptTTL,
          });
        }
      }
      cursor = page.cursor;
    } while (cursor);
  }
  return found;
}
export default definePlugin({
  async onStart(ctx) {
    if (!(await ctx.kv.get("activeIndex"))) {
      for (const event of await records(ctx))
        if (!event.ended) await ctx.kv.set("active:" + event.id, true);
      await ctx.kv.set("activeIndex", true);
    }
    await reconcile(ctx);
  },
  events: {
    async scheduledEventUpdate(ctx, event) {
      const old = await ctx.kv.get<RecordEvent>("event:" + event.id);
      if (!old) return;
      const { channel: _oldChannel, location: _oldLocation, ...rest } = old;
      await store(ctx, { ...rest, ...snapshot(event) });
      await enqueue(ctx, "inspect", { id: event.id });
    },
    async scheduledEventDelete(ctx, event) {
      await ctx.kv
        .atomic()
        .delete("event:" + event.id)
        .delete("active:" + event.id)
        .commit();
    },
  },
  schedules: {
    horizon: { cron: "8 * * * *", run: reconcile },
    attendance: { cron: "* * * * *", run: (ctx) => activePage(ctx) },
  },
  tasks: {
    async retract(ctx, p) {
      await ctx.server.retractDM((p as { messageId: string }).messageId);
    },
    async finish(ctx, p) {
      await finish(ctx, (p as EventJob).id);
    },
    async scan(ctx, p) {
      await activePage(ctx, (p as EventJob).cursor);
    },
    async inspect(ctx, p) {
      await inspect(ctx, (p as EventJob).id);
    },
    async remind(ctx, p) {
      const { id, phase } = p as EventJob;
      if (phase) await reminders(ctx, id, phase);
    },
    async sample(ctx, p) {
      const { id, minute, cursor } = p as EventJob;
      const r = await eventRow(ctx, id);
      if (r && minute !== undefined) await sample(ctx, r, minute, cursor);
    },
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
