import { expect, test, vi, afterEach, beforeEach } from "vite-plus/test";
import { createTestContext, callRoute, runCommand } from "@cicord/sdk/testing";
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
import { anniversary, validDate } from "../src/dates.ts";
test("leap birthday rolls to February 28 in the member's time zone", () => {
  expect(validDate(2, 29)).toBe(true);
  expect(validDate(2, 30)).toBe(false);
  expect(anniversary(2026, 2, 29, 9, "Europe/Paris")).toBe(Date.parse("2026-02-28T08:00:00Z"));
  expect(anniversary(2028, 2, 29, 9, "Europe/Paris")).toBe(Date.parse("2028-02-29T08:00:00Z"));
});
test("opt in, direct role replay, overdue expiry and independent erasure", async () => {
  const t = setup({
    channel: "general",
    timeZone: "Europe/Paris",
    role: "birthday",
    eraseOnLeave: true,
  });
  expect(
    (await callRoute(plugin, t, "PUT /birthday", { body: { day: 29, month: 2 } })).status,
  ).toBe(401);
  const put = (viewer: string, day: number) =>
    callRoute(plugin, t, "PUT /birthday", { viewer, body: { day, month: 2 } });
  expect((await put("1", 31)).status).toBe(400);
  await put("1", 29);
  await put("2", 1);
  const task = t.scheduled[0]!;
  vi.setSystemTime(Date.now() + 1500);
  await plugin.tasks!.celebrate!(t.ctx, task.payload);
  await plugin.tasks!.celebrate!(t.ctx, task.payload);
  expect(t.sent).toHaveLength(1);
  expect(t.member("1")!.hasRole("birthday")).toBe(true);
  expect(t.published).toHaveLength(1);
  const expiry = t.scheduled.find((x) => x.task === "expire")!;
  vi.setSystemTime(Date.now() + 25 * 3600000);
  await plugin.tasks!.expire!(t.ctx, expiry.payload);
  await plugin.tasks!.expire!(t.ctx, expiry.payload);
  expect(t.member("1")!.hasRole("birthday")).toBe(false);
  await plugin.events!.memberLeave!(t.ctx, t.member("1")!.user);
  expect(await plugin.privacy!.export(t.ctx, "1")).toEqual({});
  expect(await plugin.privacy!.export(t.ctx, "2")).toMatchObject({
    birthday: { day: 1, month: 2 },
  });
});
test("denied or timed out provider never falls back to an untracked role mutation", async () => {
  const t = setup({ channel: "general", role: "birthday", hour: 8 });
  const call = vi.fn().mockRejectedValueOnce(Error("timeout")).mockResolvedValue({});
  Object.assign(t.ctx, { plugins: { has: (name: string) => name === "member-roles", call } });
  await callRoute(plugin, t, "PUT /birthday", { viewer: "1", body: { day: 28, month: 2 } });
  const p = t.scheduled[0]!.payload;
  vi.setSystemTime(Date.now() + 1500);
  await expect(plugin.tasks!.celebrate!(t.ctx, p)).rejects.toThrow("timeout");
  await plugin.tasks!.celebrate!(t.ctx, p);
  expect(call).toHaveBeenCalledTimes(2);
  expect(call.mock.calls[1]![3]).toEqual(call.mock.calls[0]![3]);
  expect(t.roleChanges).toEqual([]);
  expect(t.sent).toHaveLength(1);
});
test("an offline December birthday is caught up when the server restarts in January", async () => {
  vi.setSystemTime(Date.parse("2026-12-30T12:00:00Z"));
  const t = setup({ channel: "general", timeZone: "Pacific/Auckland", hour: 9 });
  await callRoute(plugin, t, "PUT /birthday", { viewer: "1", body: { day: 31, month: 12 } });
  const p = t.scheduled[0]!.payload;
  vi.setSystemTime(Date.parse("2027-01-01T04:00:00Z"));
  await plugin.tasks!.celebrate!(t.ctx, p);
  expect(t.published).toHaveLength(1);
  expect(await plugin.privacy!.export(t.ctx, "1")).toMatchObject({ lastCelebrationYear: 2026 });
});
test("remove then set again never repeats the year's greeting, role or event", async () => {
  vi.setSystemTime(Date.parse("2026-03-10T12:00:00Z"));
  const t = setup({ channel: "general", role: "birthday" });
  const cycle = async () => {
    await callRoute(plugin, t, "PUT /birthday", { viewer: "2", body: { day: 10, month: 3 } });
    const task = t.scheduled.filter((x) => x.task === "celebrate").at(-1)!;
    vi.setSystemTime(Date.now() + 1500);
    await plugin.tasks!.celebrate!(t.ctx, task.payload);
    // A replayed delivery of the same task changes nothing either.
    await plugin.tasks!.celebrate!(t.ctx, task.payload);
    return task;
  };
  const first = await cycle();
  expect(t.member("2")!.hasRole("birthday")).toBe(true);
  for (let n = 0; n < 2; n++) {
    await callRoute(plugin, t, "DELETE /birthday", { viewer: "2" });
    expect(t.member("2")!.hasRole("birthday")).toBe(false);
    await cycle();
  }
  await runCommand(plugin, t, "birthday remove", { user: "2" });
  await runCommand(plugin, t, "birthday set", { user: "2", options: { day: 11, month: 3 } });
  vi.setSystemTime(Date.parse("2026-03-11T12:00:00Z"));
  for (const task of t.scheduled.filter((x) => x.task === "celebrate"))
    await plugin.tasks!.celebrate!(t.ctx, task.payload);
  await plugin.tasks!.celebrate!(t.ctx, first.payload);
  expect(t.sent).toHaveLength(1);
  expect(t.published).toHaveLength(1);
  expect(t.member("2")!.hasRole("birthday")).toBe(false);
  expect(t.sent[0]!.message).toMatchObject({ nonce: "bd2-2026", enforceNonce: true });
  expect(await plugin.privacy!.export(t.ctx, "2")).toMatchObject({ celebrated: [2026] });
  // Privacy erasure (unlike the self-service withdrawal) also deletes the marker.
  await plugin.privacy!.erase(t.ctx, "2");
  expect(await plugin.privacy!.export(t.ctx, "2")).toEqual({});
  expect([...t.kv.keys()].filter((k) => k.startsWith("celebrated:"))).toEqual([]);
});
