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
