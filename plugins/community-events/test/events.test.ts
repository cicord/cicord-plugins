import { describe, expect, test, vi } from "vite-plus/test";
import { createTestContext, callRoute } from "@cicord/sdk/testing";
import plugin from "../src/index.ts";
import en from "../locales/en.json" with { type: "json" };
import fr from "../locales/fr.json" with { type: "json" };
import schema from "../config.schema.json" with { type: "json" };
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
        await plugin.schedules!.attendance!.run(h.ctx);
      }
      await plugin.schedules!.attendance!.run(h.ctx);
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
    await plugin.schedules!.attendance!.run(h.ctx);
    await plugin.schedules!.attendance!.run(h.ctx);
    vi.setSystemTime(at);
    await plugin.schedules!.attendance!.run(h.ctx);
    await plugin.schedules!.attendance!.run(h.ctx);
    expect(h.sent.map((x) => x.to)).toEqual(["dm:1", "dm:1"]);
  } finally {
    vi.useRealTimers();
  }
});
