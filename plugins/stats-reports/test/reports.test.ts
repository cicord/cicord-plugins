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
      channels: {
        staff: { name: "staff", overwrites: { "@everyone": { deny: ["ViewChannel"] } } },
      },
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

test("concurrent triggers followed by a crash and a late retry never resend a report outside the nonce window", async () => {
  vi.useFakeTimers();
  const at = Date.parse("2030-01-08T12:00:00Z");
  vi.setSystemTime(at);
  try {
    const h = createTestContext({
      schema,
      locales: { en, fr },
      analytics: data,
      config: { staffChannel: "staff" },
      channels: {
        staff: { name: "staff", overwrites: { "@everyone": { deny: ["ViewChannel"] } } },
      },
    });
    const set = h.ctx.kv.set.bind(h.ctx.kv);
    let crash = true;
    h.ctx.kv.set = async (k, v, o) => {
      if (
        crash &&
        k.startsWith("report:week") &&
        v &&
        typeof v === "object" &&
        "state" in v &&
        v.state === "done"
      ) {
        crash = false;
        throw new Error("lost acknowledgement");
      }
      await set(k, v, o);
    };
    const run = () => plugin.schedules!.reports!.run(h.ctx);
    await Promise.allSettled([run(), run()]);
    const staff = h.ctx.server.channel("staff");
    for (let i = 0; i < 60; i++) await staff.send("other message " + i);
    vi.setSystemTime(at + 6 * 60000);
    await run();
    await run();
    const embeds = h.sent.filter(
      (m) => typeof m.message !== "string" && m.message.embeds?.[0]?.title?.includes("week"),
    );
    expect(embeds).toHaveLength(1);
    expect(await h.ctx.kv.get("report:week:2030-01-07")).toMatchObject({ state: "uncertain" });
  } finally {
    vi.useRealTimers();
  }
});
test("counter creation is reserved before Discord runs and remains blocked after an unknown outcome", async () => {
  const h = createTestContext({
    schema,
    locales: { en, fr },
    config: { counters: ["members.total"] },
  });
  const create = h.ctx.server.createChannel.bind(h.ctx.server);
  h.ctx.server.createChannel = async (opts) => {
    await create(opts);
    throw new Error("response lost");
  };
  await Promise.allSettled([updateCounters(h.ctx, data, 0), updateCounters(h.ctx, data, 0)]);
  await updateCounters(h.ctx, data, 600000);
  await updateCounters(h.ctx, data, 700000);
  expect(h.createdChannels).toHaveLength(1);
  expect(await h.ctx.kv.get("counter:members.total")).toMatchObject({ state: "uncertain" });
});
test("reports are withheld from public or unknown destinations", async () => {
  const h = createTestContext({
    schema,
    locales: { en, fr },
    analytics: data,
    server: { everyonePermissions: ["ViewChannel", "ReadMessageHistory"] },
    config: { staffChannel: "lobby" },
    channels: { lobby: { name: "lobby" } },
  });
  await plugin.schedules!.reports!.run(h.ctx);
  expect(h.sent).toHaveLength(0);
});
