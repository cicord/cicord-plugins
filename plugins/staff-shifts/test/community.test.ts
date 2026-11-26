import { expect, test, vi, afterEach, beforeEach } from "vite-plus/test";
import { createTestContext, runCommand, callRoute } from "@cicord/sdk/testing";
import schema from "../config.schema.json" with { type: "json" };
import en from "../locales/en.json" with { type: "json" };
import fr from "../locales/fr.json" with { type: "json" };
import plugin from "../src/index.ts";

function setup(config: Record<string, unknown> = {}, disabled: string[] = []) {
  const t = createTestContext({
    schema,
    locales: { en, fr },
    config,
    server: { ownerId: "1" },
    roles: { staff: { name: "Staff" }, duty: { name: "Duty" }, birthday: { name: "Birthday" } },
    channels: { general: { name: "General" }, news: { name: "News", type: "announcement" } },
    members: [{ id: "1", roles: ["staff"] }, { id: "2" }],
  });
  Object.assign(t.ctx, {
    features: { enabled: (f: string) => !disabled.includes(f) },
    plugins: { has: () => false },
  });
  return t;
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse("2026-02-28T08:00:00Z"));
});
afterEach(() => vi.useRealTimers());
import { coverage } from "../src/planning.ts";
test("computes gaps across three zones with different DST transitions", () => {
  const from = Date.parse("2026-03-29T00:00:00Z"),
    end = from + 12 * 3600000;
  const plans = [
    { zone: "Europe/Paris", shifts: [{ day: 0, start: 90, minutes: 120 }] },
    { zone: "America/New_York", shifts: [{ day: 0, start: 0, minutes: 120 }] },
    { zone: "Asia/Tokyo", shifts: [{ day: 0, start: 900, minutes: 60 }] },
  ];
  const gaps = coverage(plans, from, end).map((g) => [
    (g.from - from) / 60000,
    (g.to - from) / 60000,
  ]);
  expect(gaps).toEqual([
    [0, 30],
    [150, 240],
    [420, 720],
  ]);
});
test("duty expiry, staff permission recheck, private schedules and event replay", async () => {
  const t = setup({ staffRole: "staff", dutyRole: "duty", maxHours: 1 });
  await runCommand(plugin, t, "duty on", { user: "2" });
  expect(t.roleChanges).toEqual([]);
  await runCommand(plugin, t, "duty on", { user: "1" });
  const query = () =>
    plugin.queries!.onDuty!.run(
      t.ctx,
      {},
      { caller: { plugin: "guard", bot: "b", instance: "a", source: "cicord", verified: true } },
    );
  expect(await query()).toEqual({ userIds: ["1"] });
  const expiry = t.scheduled.find((x) => x.task === "expire")!;
  vi.setSystemTime(Date.now() + 7200000);
  await plugin.tasks!.expire!(t.ctx, expiry.payload);
  await plugin.tasks!.expire!(t.ctx, expiry.payload);
  expect(t.member("1")!.hasRole("duty")).toBe(false);
  await runCommand(plugin, t, "duty on", { user: "1" });
  await t.member("1")!.removeRole("staff");
  expect(await query()).toEqual({ userIds: [] });
  const plan = { zone: "Europe/Paris", shifts: [{ day: 1, start: 540, minutes: 60 }] };
  expect((await callRoute(plugin, t, "PUT /me/plan", { viewer: "2", body: plan })).status).toBe(
    403,
  );
  await t.member("1")!.addRole("staff");
  expect((await callRoute(plugin, t, "PUT /me/plan", { viewer: "1", body: plan })).status).toBe(
    200,
  );
  expect(t.scheduled.some((x) => x.task === "remind")).toBe(true);
  const meta = {
    id: "ticket-event",
    topic: "tickets.closed",
    version: 1,
    at: new Date().toISOString(),
    publisher: { plugin: "tickets", instance: "tickets", bot: "b" },
  };
  for (let i = 0; i < 2; i++)
    await plugin.subscriptions!["tickets.closed"]!(t.ctx, { assignee: "1" }, meta);
  expect((await callRoute(plugin, t, "GET /me", { viewer: "1" })).body).toMatchObject({
    ticket: 1,
  });
  expect((await callRoute(plugin, t, "GET /coverage", { viewer: "2" })).status).toBe(403);
});
