import type { Context, Overlay } from "@cicord/sdk";
import { createTestContext, runCommand, runComponent } from "@cicord/sdk/testing";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import schema from "../config.schema.json" with { type: "json" };
import en from "../locales/en.json" with { type: "json" };
import fr from "../locales/fr.json" with { type: "json" };
import plugin from "../src/index.ts";
import { close, publicRaid, quiet, reconcileRaid } from "../src/raid.ts";

function setup(config: Record<string, unknown> = {}, features: string[] = []) {
  const t = createTestContext({
    schema,
    locales: { en, fr },
    config: { staffChannel: "staff", ...config },
    features,
    server: { ownerId: "owner" },
    channels: { staff: { name: "Staff" }, general: { name: "General" } },
    members: [{ id: "owner" }],
  });
  const applied: Overlay[] = [],
    removed: string[] = [],
    incidents: Date[] = [];
  vi.spyOn(t.ctx.server.overlays, "apply").mockImplementation(async (o) => {
    applied.push(o);
  });
  vi.spyOn(t.ctx.server.overlays, "remove").mockImplementation(async (id) => {
    removed.push(id);
  });
  vi.spyOn(t.ctx.server, "incident").mockImplementation(async (a) => {
    incidents.push(a.invitesDisabledUntil!);
  });
  return { ...t, applied, removed, incidents };
}
type Harness = ReturnType<typeof setup>;
let seq = 0;
async function arrive(t: Harness, n: number, ctx: Context = t.ctx) {
  for (let i = 0; i < n; i++) {
    const m = t.addMember({ id: String(1000 + ++seq), joinedAt: new Date() });
    await plugin.events!.memberJoin!(ctx, m);
  }
}
const lockdown = (t: Harness, on: boolean) =>
  runCommand(plugin, t, on ? "lockdown on" : "lockdown off", { user: "owner" });
const reply = (r: { replies: unknown[] }) => JSON.stringify(r.replies[0]);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-26T12:00:00Z"));
});
afterEach(() => vi.useRealTimers());

describe("manual lockdown (MOD-04)", () => {
  test("in monitor mode a staff lockdown applies the measures and survives the minute check", async () => {
    const t = setup({ raid: { calmMinutes: 30 } }, ["raidOverlay", "pauseInvites"]);
    const r = await lockdown(t, true);
    expect(reply(r)).toContain(en["message.lockdownActive"]);
    expect(t.applied.map((o) => o.id)).toEqual(["raid"]);
    expect(t.incidents).toHaveLength(1);
    expect(await publicRaid(t.ctx)).toMatchObject({ manual: true, enforced: true, phase: "active" });
    vi.advanceTimersByTime(60_000);
    await quiet(t.ctx);
    const raid = await t.ctx.kv.get<{ started: number; wake: string }>("raid");
    await reconcileRaid(t.ctx, raid!.started, raid!.wake);
    expect(await publicRaid(t.ctx)).toMatchObject({ phase: "active" });
    expect(t.removed).toEqual([]);
    // An automatic surge during the manual lockdown keeps it enforced.
    await arrive(t, 20);
    expect(await publicRaid(t.ctx)).toMatchObject({ manual: true, enforced: true });
  });
  test("a locked channel also neutralizes role allows of Send Messages (MOD-03)", async () => {
    const t = setup({ raid: { measures: { lockChannels: ["general"] } } }, ["raidOverlay"]);
    await lockdown(t, true);
    expect(t.applied[0]?.channels?.general?.overwrites).toEqual({
      "@everyone": { deny: ["SendMessages", "SendMessagesInThreads"] },
      "*": { neutral: ["SendMessages", "SendMessagesInThreads"] },
    });
  });
  test("without the overlay grant nothing is recorded and staff are told", async () => {
    const t = setup();
    const r = await lockdown(t, true);
    expect(reply(r)).toContain(en["message.lockdownRefused"]);
    expect(await publicRaid(t.ctx)).toBeNull();
    expect(t.applied).toEqual([]);
  });
  test("a monitor-mode surge applies nothing until staff escalate it", async () => {
    const t = setup({}, ["raidOverlay"]);
    await arrive(t, 15);
    expect(await publicRaid(t.ctx)).toMatchObject({ enforced: false });
    expect(t.applied).toEqual([]);
    await lockdown(t, true);
    expect(t.applied.map((o) => o.id)).toEqual(["raid"]);
  });
});

describe("join bursts (MOD-05)", () => {
  test("a surge applies the overlay and the invite pause once, then about once a minute", async () => {
    const t = setup({ mode: "enforce" }, ["raidOverlay", "pauseInvites"]);
    await arrive(t, 200);
    expect(t.applied).toHaveLength(1);
    expect(t.incidents).toHaveLength(1);
    // The surge continues for three minutes, one join every second.
    for (let s = 0; s < 180; s++) {
      vi.advanceTimersByTime(1000);
      await arrive(t, 1);
    }
    expect(t.applied.length).toBeGreaterThan(1);
    expect(t.applied.length).toBeLessThanOrEqual(4);
    expect(t.incidents.length).toBeLessThanOrEqual(4);
    // The overlay always outlives the raid deadline it protects.
    const raid = (await publicRaid(t.ctx))!;
    expect(+t.applied.at(-1)!.until).toBeGreaterThan(raid.until);
  });
  test("joins are recorded while the raid lock is held elsewhere", async () => {
    const t = setup({ mode: "enforce" }, ["raidOverlay"]);
    await t.ctx.kv.set("lock:raid", "another-handler", { ttlSeconds: 60 });
    await arrive(t, 3);
    expect([...t.kv.keys()].filter((k) => k.startsWith("join:"))).toHaveLength(3);
  });
  test("join and arrival keys are exported and erased per member", async () => {
    const t = setup({ mode: "enforce", raid: { joins: 2 } }, ["raidOverlay"]);
    await arrive(t, 3);
    const id = String(1000 + seq);
    expect(await plugin.privacy!.export(t.ctx, id)).toMatchObject({
      "join:": expect.anything(),
      "arrival:": expect.anything(),
    });
    await plugin.privacy!.erase(t.ctx, id);
    expect(await plugin.privacy!.export(t.ctx, id)).toEqual({});
    expect(t.kv.has("arrival:" + String(1000 + seq - 1))).toBe(true);
  });
});

describe("lifting (MOD-13)", () => {
  test("lift, close and /lockdown off resume paused invites within seconds", async () => {
    const t = setup({ mode: "enforce" }, ["raidOverlay", "pauseInvites"]);
    await arrive(t, 15);
    expect(t.incidents).toHaveLength(1);
    expect(+t.incidents[0]! - Date.now()).toBeGreaterThan(10 * 60000);
    const raid = (await publicRaid(t.ctx))!;
    const r = await runComponent(plugin, t, "lift:" + raid.started, { user: "owner" });
    expect(JSON.stringify(r.replies)).toContain(en["message.lifted"]);
    expect(t.incidents).toHaveLength(2);
    expect(+t.incidents[1]! - Date.now()).toBeLessThanOrEqual(5000);
    expect(t.removed).toEqual(["raid"]);
    expect(await publicRaid(t.ctx)).toBeNull();
    expect([...t.kv.keys()].some((k) => k.startsWith("arrival:"))).toBe(false);
    await lockdown(t, true);
    await lockdown(t, false);
    expect(+t.incidents.at(-1)! - Date.now()).toBeLessThanOrEqual(5000);
  });
  test("without a pause nothing is sent to Discord's invite settings", async () => {
    const t = setup({ mode: "enforce" }, ["raidOverlay"]);
    await arrive(t, 15);
    expect(await close(t.ctx)).toBe(true);
    expect(t.incidents).toEqual([]);
  });
});
