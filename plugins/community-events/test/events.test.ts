import { describe, expect, test, vi } from "vite-plus/test";
import { createTestContext, callRoute } from "@cicord/sdk/testing";
import plugin from "../src/index.ts";
import en from "../locales/en.json" with { type: "json" };
import fr from "../locales/fr.json" with { type: "json" };
import schema from "../config.schema.json" with { type: "json" };
async function tick(h: ReturnType<typeof createTestContext>) {
  await plugin.schedules!.attendance!.run(h.ctx);
  for (let n = 0; n < 100; n++) {
    const j = h.scheduled.findIndex((t) => t.delayMs <= 1);
    if (j < 0) return;
    const [task] = h.scheduled.splice(j, 1);
    await plugin.tasks![task!.task]!(h.ctx, task!.payload);
  }
  throw new Error("Task queue did not settle");
}
describe("calendar", () => {
  test("stable native occurrences and one ICS series survive restarts and config edits", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    try {
      const h = createTestContext({
        locales: { en, fr },
        schema,
        config: {
          weeksAhead: 3,
          series: [
            {
              key: "weekly",
              name: "Friday, night",
              start: "2030-01-04T21:00:00Z",
              durationMinutes: 90,
              location: "Hall",
            },
          ],
        },
      });
      await plugin.onStart!(h.ctx);
      await plugin.onStart!(h.ctx);
      const events = await h.ctx.server.scheduledEvents();
      expect(events).toHaveLength(3);
      const before = await callRoute(plugin, h, "GET /calendar.ics");
      expect(before.headers["content-type"]).toBe("text/calendar; charset=utf-8");
      expect(before.body).toContain("RRULE:FREQ=WEEKLY");
      expect(before.body).toContain("Friday\\, night");
      const uid = String(before.body).match(/UID:[^\r]+/)![0];
      h.ctx.config.series[0]!.durationMinutes = 120;
      await plugin.onStart!(h.ctx);
      const after = await callRoute(plugin, h, "GET /calendar.ics");
      expect(after.body).toContain(uid);
      expect(after.body).toContain("DTEND:20300104T230000Z");
      expect((await h.ctx.server.scheduledEvents()).map((e) => e.id)).toEqual(
        events.map((e) => e.id),
      );
    } finally {
      vi.useRealTimers();
    }
  });
  test("only consecutive minutes in voice qualify, and ended is emitted once", async () => {
    vi.useFakeTimers();
    const start = Date.parse("2030-01-01T20:00:00Z");
    vi.setSystemTime(start - 60000);
    try {
      const h = createTestContext({
        locales: { en, fr },
        schema,
        channels: { voice: { name: "voice", type: "voice" } },
        members: [{ id: "1" }, { id: "2" }],
        config: {
          weeksAhead: 1,
          minMinutes: 2,
          series: [
            {
              key: "v",
              name: "Voice",
              start: new Date(start).toISOString(),
              durationMinutes: 4,
              channel: "voice",
            },
          ],
        },
      });
      await plugin.onStart!(h.ctx);
      h.setVoice("1", "voice");
      for (let i = 0; i <= 4; i++) {
        vi.setSystemTime(start + i * 60000);
        if (i === 2) h.setVoice("2", "voice");
        if (i === 3) h.setVoice("2", null);
        await tick(h);
      }
      await tick(h);
      const ended = h.published.filter((e) => e.topic === "ended");
      expect(ended).toHaveLength(1);
      expect(ended[0]!.payload).toMatchObject({ attendees: ["1"] });
    } finally {
      vi.useRealTimers();
    }
  });
});

test("the calendar reads only live and recently ended events, never the whole history", async () => {
  vi.useFakeTimers();
  const start = Date.parse("2030-01-01T20:00:00Z");
  vi.setSystemTime(start - 60000);
  try {
    const h = createTestContext({
      locales: { en, fr },
      schema,
      server: { everyonePermissions: ["ViewChannel", "ReadMessageHistory"] },
      channels: { voice: { name: "voice", type: "voice" } },
      config: {
        weeksAhead: 1,
        series: [
          {
            key: "v",
            name: "Voice",
            start: new Date(start).toISOString(),
            durationMinutes: 2,
            channel: "voice",
          },
        ],
      },
    });
    await plugin.onStart!(h.ctx);
    // Years of ended events, as an old server has: history, not calendar entries.
    for (let i = 0; i < 3000; i++)
      await h.ctx.kv.set("event:old" + i, {
        id: "old" + i,
        name: "Old " + i,
        start: "2020-01-01T20:00:00.000Z",
        ended: true,
      });
    // The prefixes the calendar routes list (the attendance task lists its own indexes).
    const prefixes: (string | undefined)[] = [];
    let routing = false;
    const list = h.ctx.kv.list.bind(h.ctx.kv);
    h.ctx.kv.list = ((o?: { prefix?: string }) => {
      if (routing) prefixes.push(o?.prefix);
      return list(o);
    }) as typeof h.ctx.kv.list;
    const names = async () => {
      routing = true;
      try {
        return ((await callRoute(plugin, h, "GET /calendar")).body as { name: string }[]).map(
          (e) => e.name,
        );
      } finally {
        routing = false;
      }
    };
    expect(await names()).toEqual(["Voice"]);
    expect(String((await callRoute(plugin, h, "GET /calendar.ics")).body)).not.toContain("Old 1");
    for (let i = 0; i <= 3; i++) {
      vi.setSystemTime(start + i * 60000);
      await tick(h);
    }
    await tick(h);
    expect(h.published.filter((e) => e.topic === "ended")).toHaveLength(1);
    // Ended: still listed for CALENDAR_DAYS (30), then it leaves the calendar.
    expect(await names()).toEqual(["Voice"]);
    vi.setSystemTime(start + 31 * 86400000);
    expect(await names()).toEqual([]);
    expect(prefixes.length).toBeGreaterThan(0);
    expect(prefixes.every((p) => p === "active:" || p === "recent:")).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

test("interested members receive each reminder only with a saved opt-in", async () => {
  vi.useFakeTimers();
  const at = Date.parse("2030-01-02T21:00:00Z");
  vi.setSystemTime(at - 3600000);
  try {
    const h = createTestContext({
      locales: { en, fr },
      schema,
      members: [{ id: "1" }, { id: "2" }],
      config: {
        weeksAhead: 1,
        series: [
          {
            key: "night",
            name: "Night",
            start: new Date(at).toISOString(),
            durationMinutes: 120,
            location: "Hall",
          },
        ],
      },
    });
    await plugin.onStart!(h.ctx);
    const [event] = await h.ctx.server.scheduledEvents();
    event!.users = async () => ["1", "2"];
    await h.ctx.kv.set("opt:1", true);
    await tick(h);
    await tick(h);
    vi.setSystemTime(at);
    await tick(h);
    await tick(h);
    expect(h.sent.map((x) => x.to)).toEqual(["dm:1", "dm:1"]);
  } finally {
    vi.useRealTimers();
  }
});

test("a replay after a lost acknowledgement uses the same nonce; an ambiguous late retry never resends", async () => {
  vi.useFakeTimers();
  const at = Date.parse("2030-01-02T21:00:00Z");
  vi.setSystemTime(at);
  try {
    const h = createTestContext({
      locales: { en, fr },
      schema,
      config: {
        weeksAhead: 1,
        series: [
          {
            key: "one",
            name: "Party",
            start: new Date(at).toISOString(),
            durationMinutes: 120,
            location: "Hall",
          },
        ],
      },
      members: [{ id: "1" }, { id: "2" }],
    });
    await plugin.onStart!(h.ctx);
    const [e] = await h.ctx.server.scheduledEvents();
    e!.users = async () => ["1", "2"];
    for (const id of ["1", "2"]) await h.ctx.kv.set("opt:" + id, true);
    const deliver = () => plugin.tasks!.remind!(h.ctx, { id: e!.id, phase: "start" });
    const member = h.member("1")!,
      send = member.send.bind(member);
    let lost = true;
    member.send = async (message, options) => {
      const actual = await send(message, options);
      if (lost) {
        lost = false;
        throw new Error("simulated crash after Discord accepted the DM");
      }
      return actual;
    };
    const results = await Promise.allSettled([deliver(), deliver()]);
    expect(results.some((r) => r.status === "rejected")).toBe(true);
    expect(h.sent).toHaveLength(1);
    vi.setSystemTime(at + 13000);
    await deliver();
    expect(h.sent.map((x) => x.to)).toEqual(["dm:1", "dm:2"]);
    await plugin.privacy!.erase(h.ctx, "1");
    expect(h.deletedMessages.map((x) => x.id)).toContain(h.sent[0]!.id);
    await h.ctx.kv.set("sent:2:" + e!.id + ":start", {
      state: "running",
      first: at,
      lease: at + 12000,
    });
    await h.ctx.kv.delete("phase:" + e!.id + ":start");
    vi.setSystemTime(at + 2 * 60000);
    await deliver();
    expect(h.sent).toHaveLength(2);
    expect(await h.ctx.kv.get("sent:2:" + e!.id + ":start")).toMatchObject({ state: "uncertain" });
  } finally {
    vi.useRealTimers();
  }
});
test("private event titles stay out of the public calendar, public announcements and revoked member DMs", async () => {
  vi.useFakeTimers();
  const at = Date.parse("2030-01-02T21:00:00Z");
  vi.setSystemTime(at);
  try {
    const h = createTestContext({
      locales: { en, fr },
      schema,
      server: { everyonePermissions: ["ViewChannel", "ReadMessageHistory"] },
      roles: { staff: { name: "Staff" } },
      members: [
        { id: "1", roles: ["staff"] },
        { id: "2", roles: ["staff"] },
      ],
      channels: {
        public: { name: "public" },
        staff: {
          name: "private",
          type: "voice",
          overwrites: { "@everyone": { deny: ["ViewChannel"] }, staff: { allow: ["ViewChannel"] } },
        },
      },
      config: {
        weeksAhead: 1,
        announcementChannel: "public",
        series: [
          {
            key: "one",
            name: "Confidential",
            start: new Date(at).toISOString(),
            durationMinutes: 120,
            channel: "staff",
          },
        ],
      },
    });
    await plugin.onStart!(h.ctx);
    const [e] = await h.ctx.server.scheduledEvents();
    e!.users = async () => ["1", "2"];
    for (const id of ["1", "2"]) await h.ctx.kv.set("opt:" + id, true);
    await plugin.tasks!.inspect!(h.ctx, { id: e!.id });
    await h.member("2")!.removeRole("staff");
    await plugin.tasks!.remind!(h.ctx, { id: e!.id, phase: "start" });
    expect(h.sent.map((x) => x.to)).toEqual(["dm:1"]);
    for (const route of ["GET /calendar", "GET /calendar.ics"])
      expect(JSON.stringify((await callRoute(plugin, h, route)).body)).not.toContain(
        "Confidential",
      );
  } finally {
    vi.useRealTimers();
  }
});
describe("time zones and bounded reconciliation", () => {
  const base = (series: Record<string, unknown>[], weeksAhead = 3) =>
    createTestContext({ locales: { en, fr }, schema, config: { weeksAhead, series } });
  test("a zoned weekly series keeps its local time across DST, in Discord and in ICS", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-03-20T00:00:00Z"));
    try {
      const h = base([
        {
          key: "games",
          name: "Friday games",
          start: "2030-03-22T20:00:00Z", // 21:00 in Paris (CET)
          timeZone: "Europe/Paris",
          durationMinutes: 90,
          location: "Hall",
        },
        { key: "utc", name: "UTC call", start: "2030-03-22T20:00:00Z", durationMinutes: 30 },
      ]);
      await plugin.onStart!(h.ctx);
      const starts = (name: string) =>
        h.ctx.server
          .scheduledEvents()
          .then((all) => all.filter((e) => e.name === name).map((e) => e.start));
      // Paris moves to CEST on 31 March 2030: 21:00 local is then 19:00 UTC.
      expect(await starts("Friday games")).toEqual([
        "2030-03-22T20:00:00.000Z",
        "2030-03-29T20:00:00.000Z",
        "2030-04-05T19:00:00.000Z",
      ]);
      expect(await starts("UTC call")).toEqual([
        "2030-03-22T20:00:00.000Z",
        "2030-03-29T20:00:00.000Z",
        "2030-04-05T20:00:00.000Z",
      ]);
      const body = String((await callRoute(plugin, h, "GET /calendar.ics")).body);
      expect(body).toContain("DTSTART;TZID=Europe/Paris:20300322T210000");
      expect(body).toContain("DTEND;TZID=Europe/Paris:20300322T223000");
      expect(body).toContain("DTSTART:20300322T200000Z");
      expect(body).toMatch(
        /BEGIN:VTIMEZONE\r\nTZID:Europe\/Paris\r\nBEGIN:DAYLIGHT\r\nDTSTART:19700329T020000\r\nRRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU\r\nTZOFFSETFROM:\+0100\r\nTZOFFSETTO:\+0200/,
      );
      expect(body).toContain("DTSTART:19701025T030000");
      // A restart in the next week keeps the same occurrences.
      vi.setSystemTime(new Date("2030-03-25T00:00:00Z"));
      await plugin.onStart!(h.ctx);
      expect(await starts("Friday games")).toHaveLength(4);
    } finally {
      vi.useRealTimers();
    }
  });
  test("missing Manage Events is a status line; long horizons continue in bounded tasks", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    try {
      const h = base(
        [{ key: "w", name: "Weekly", start: "2030-01-04T21:00:00Z", durationMinutes: 60 }],
        26,
      );
      const notices = new Map<string, string | null>();
      const server = h.ctx.server;
      const create = server.createScheduledEvent.bind(server);
      let denied = true;
      Object.assign(h.ctx, {
        status: { set: (k: string, v: string | null) => notices.set(k, v) },
        server: Object.assign(Object.create(server), {
          createScheduledEvent: async (input: Parameters<typeof create>[0]) => {
            if (denied)
              throw new Error(
                "discord create scheduled event: discord: missing permissions (HTTP 403 50013: Missing Permissions)",
              );
            return create(input);
          },
        }),
      });
      await plugin.onStart!(h.ctx);
      expect(notices.get("manageEvents")).toContain("Manage Events");
      denied = false;
      await plugin.onStart!(h.ctx);
      expect(await server.scheduledEvents()).toHaveLength(10);
      expect(notices.get("manageEvents")).toBeNull();
      // A restart while the continuation is pending creates no duplicate.
      await plugin.onStart!(h.ctx);
      for (let n = 0; n < 10; n++) {
        const j = h.scheduled.findIndex((t) => t.task === "reconcile");
        if (j < 0) break;
        const [task] = h.scheduled.splice(j, 1);
        await plugin.tasks!.reconcile!(h.ctx, task!.payload);
      }
      const all = await server.scheduledEvents();
      expect(all).toHaveLength(26);
      expect(new Set(all.map((e) => e.start)).size).toBe(26);
    } finally {
      vi.useRealTimers();
    }
  });
  test("the active index migration runs in bounded tasks, not in onStart", async () => {
    const h = base([]);
    for (let n = 0; n < 150; n++)
      await h.ctx.kv.set("event:" + n, {
        id: String(n),
        name: "Old",
        start: "2020-01-01T00:00:00Z",
        ...(n % 2 ? { ended: true } : {}),
      });
    await plugin.onStart!(h.ctx);
    expect([...h.kv.keys()].some((k) => k.startsWith("active:"))).toBe(false);
    for (let n = 0; n < 5; n++) {
      const j = h.scheduled.findIndex((t) => t.task === "backfill");
      if (j < 0) break;
      const [task] = h.scheduled.splice(j, 1);
      await plugin.tasks!.backfill!(h.ctx, task!.payload);
    }
    expect([...h.kv.keys()].filter((k) => k.startsWith("active:"))).toHaveLength(75);
    expect(await h.ctx.kv.get("meta:schema")).toBe(1);
  });
});
