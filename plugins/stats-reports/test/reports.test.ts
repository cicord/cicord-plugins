import { test, expect, vi } from "vite-plus/test";
import { createTestContext } from "@cicord/sdk/testing";
import type { AnalyticsSummary } from "@cicord/sdk";
import plugin, { shortStays, updateCounters } from "../src/index.ts";
import en from "../locales/en.json" with { type: "json" };
import fr from "../locales/fr.json" with { type: "json" };
import schema from "../config.schema.json" with { type: "json" };
const data: AnalyticsSummary = {
  from: "2030-01-01",
  to: "2030-01-08",
  granularity: "day",
  channels: [],
  heatmap: [],
  kpis: [{ metric: "members.total", value: 100 }],
  series: [],
};
test("20 of 100 short stays, no raw join identifiers, report and counter retry limits", async () => {
  vi.useFakeTimers();
  const now = Date.parse("2030-01-03T00:00:00Z"),
    day = 86400000;
  vi.setSystemTime(now);
  try {
    const h = createTestContext({
      locales: { en, fr },
      schema,
      config: { staffChannel: "staff", counters: ["members.total"] },
      analytics: data,
      features: ["cohorts", "counters"],
      channels: { staff: { name: "staff" } },
      members: Array.from({ length: 100 }, (_, i) => ({
        id: String(1000 + i),
        joinedAt: new Date(now),
      })),
    });
    for (let i = 0; i < 100; i++)
      await plugin.events!.memberJoin!(h.ctx, h.member(String(1000 + i))!);
    vi.setSystemTime(now + 3 * day);
    for (let i = 0; i < 20; i++)
      await plugin.events!.memberLeave!(h.ctx, h.member(String(1000 + i))!.user);
    expect(await shortStays(h.ctx, now, now + 7 * day)).toEqual({ joined: 100, left: 20 });
    expect(h.kv.has("arrival:1001")).toBe(false);
    await updateCounters(h.ctx, data, now);
    for (let i = 1; i <= 5; i++)
      await updateCounters(
        h.ctx,
        { ...data, kpis: [{ metric: "members.total", value: 100 + i }] },
        now + i * 1000,
      );
    expect(h.editedChannels).toHaveLength(2);
    await updateCounters(
      h.ctx,
      { ...data, kpis: [{ metric: "members.total", value: 105 }] },
      now + 601000,
    );
    expect(h.editedChannels.at(-1)?.options.name).toBe("Members: 105");
    await plugin.schedules!.reports!.run(h.ctx);
    await plugin.schedules!.reports!.run(h.ctx);
    expect(h.sent).toHaveLength(2);
  } finally {
    vi.useRealTimers();
  }
});
