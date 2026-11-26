import type { InteropCall } from "@cicord/sdk";
import { createTestContext, runCommand } from "@cicord/sdk/testing";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import en from "../locales/en.json" with { type: "json" };
import schema from "../config.schema.json" with { type: "json" };
import plugin from "../src/index.ts";

// A level is a business fact reached once per member (and per season after a reset):
// reaction toggles, admin remove/give and replays never re-cross it.
function setup(config: Record<string, unknown> = {}) {
  return createTestContext({
    schema,
    locales: { en },
    features: ["levelEvents"],
    config: {
      xpPerMessage: 95,
      reactionXp: 5,
      announce: { channel: "level-ups" },
      rewards: [{ level: 1, role: "regular" }],
      ...config,
    },
    roles: { regular: { name: "Regular" }, veteran: { name: "Veteran" } },
    channels: { general: { name: "general" }, "level-ups": { name: "level-ups" } },
    members: [
      { id: "1", username: "alice" },
      { id: "2", username: "bob" },
      { id: "9", username: "admin" },
    ],
    server: { ownerId: "9" },
  });
}
type Harness = ReturnType<typeof setup>;

async function chat(h: Harness, uid: string) {
  const message = h.receive("general", h.member(uid)!.user, "hello there");
  await plugin.events!.messageCreate!(h.ctx, { ...message, member: h.member(uid)! });
  return message;
}
const announcements = (h: Harness) => h.sent.filter((s) => s.to === "level-ups");
const levelUps = (h: Harness) => h.published.filter((p) => p.topic === "levelUp");
const call = (key: string): InteropCall & { idempotencyKey: string } => ({
  caller: { plugin: "economy", bot: "bot", instance: "economy", source: "x", verified: true },
  idempotencyKey: key,
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-21T12:00:00Z"));
});
afterEach(() => vi.useRealTimers());

test("reaction toggles cross a level once: one levelUp, one announcement, one role grant", async () => {
  const h = setup();
  const message = await chat(h, "1");
  const bob = h.member("2")!.user;
  for (let cycle = 0; cycle < 5; cycle++) {
    await plugin.events!.reactionAdd!(h.ctx, { message, user: bob, emoji: "👍" });
    expect(h.kv.get("xp:1")).toBe(100);
    await plugin.events!.reactionRemove!(h.ctx, { message, user: bob, emoji: "👍" });
    expect(h.kv.get("xp:1")).toBe(95);
  }
  expect(levelUps(h)).toEqual([
    { topic: "levelUp", payload: { userId: "1", level: 1, previous: 0, xp: 100 } },
  ]);
  expect(announcements(h)).toHaveLength(1);
  expect(h.roleChanges.filter((c) => c.action === "add")).toHaveLength(1);
  expect(h.roleChanges.filter((c) => c.action === "remove")).toHaveLength(0);
});

test("concurrent crossing awards publish and announce one level-up", async () => {
  const h = setup({ xpPerMessage: 0 });
  await h.ctx.kv.set("xp:1", 95);
  await Promise.all(
    Array.from({ length: 6 }, (_, n) =>
      plugin.actions!.grantXp!.run(h.ctx, { userId: "1", amount: n % 2 ? -5 : 5 }, call("k" + n)),
    ),
  );
  for (let n = 6; n < 12; n++)
    await plugin.actions!.grantXp!.run(
      h.ctx,
      { userId: "1", amount: n % 2 ? -5 : 5 },
      call("k" + n),
    );
  expect(levelUps(h)).toHaveLength(1);
  expect(announcements(h)).toHaveLength(1);
});

test("/xp remove then /xp give does not re-cross a level", async () => {
  const h = setup();
  await chat(h, "1");
  await plugin.actions!.grantXp!.run(h.ctx, { userId: "1", amount: 5 }, call("a"));
  await runCommand(plugin, h, "xp remove", {
    user: "9",
    options: { member: h.member("1")!.user, amount: 50 },
  });
  await runCommand(plugin, h, "xp give", {
    user: "9",
    options: { member: h.member("1")!.user, amount: 50 },
  });
  expect(h.kv.get("xp:1")).toBe(100);
  expect(levelUps(h)).toHaveLength(1);
  expect(announcements(h)).toHaveLength(1);
  // Crossing a new level still counts once.
  await plugin.actions!.grantXp!.run(h.ctx, { userId: "1", amount: 200 }, call("b"));
  expect(levelUps(h).map((p) => (p.payload as { level: number }).level)).toEqual([1, 2]);
  expect((levelUps(h)[1]!.payload as { previous: number }).previous).toBe(1);
});

test("an existing member's current level counts as reached without a stored peak", async () => {
  const h = setup({ xpPerMessage: 0 });
  await h.ctx.kv.set("xp:1", 100); // level 1 before the upgrade, no peak record
  await plugin.actions!.grantXp!.run(h.ctx, { userId: "1", amount: -10 }, call("down"));
  await plugin.actions!.grantXp!.run(h.ctx, { userId: "1", amount: 10 }, call("up"));
  expect(levelUps(h)).toHaveLength(0);
  expect(announcements(h)).toHaveLength(0);
});

test("a crash after the XP commit still applies the role reward and announces once on replay", async () => {
  const h = setup({ xpPerMessage: 0 });
  await h.ctx.kv.set("xp:1", 95);
  const member = h.ctx.server.member.bind(h.ctx.server);
  let crash = true;
  h.ctx.server.member = async (id) => {
    if (crash) {
      crash = false;
      throw new Error("process lost");
    }
    return member(id);
  };
  await expect(
    plugin.actions!.grantXp!.run(h.ctx, { userId: "1", amount: 5 }, call("same")),
  ).rejects.toThrow("process lost");
  expect(h.kv.get("xp:1")).toBe(100);
  expect(
    await plugin.actions!.grantXp!.run(h.ctx, { userId: "1", amount: 5 }, call("same")),
  ).toEqual({ xp: 100 });
  expect(h.member("1")!.hasRole("regular")).toBe(true);
  expect(levelUps(h)).toHaveLength(1);
  expect(announcements(h)).toHaveLength(1);
  // A further replay is a no-op.
  await plugin.actions!.grantXp!.run(h.ctx, { userId: "1", amount: 5 }, call("same"));
  expect(announcements(h)).toHaveLength(1);
});

function crashOnPublish(h: Harness) {
  const publish = h.ctx.events.publish.bind(h.ctx.events);
  let crash = true;
  h.ctx.events.publish = async (...args: Parameters<typeof publish>) => {
    if (crash) {
      crash = false;
      throw new Error("process lost");
    }
    return publish(...args);
  };
}

test("a redelivered reaction after a crash replays the level-up side effects", async () => {
  const h = setup();
  const message = await chat(h, "1"); // 95 XP: no level yet
  crashOnPublish(h);
  const bob = h.member("2")!.user;
  await expect(
    plugin.events!.reactionAdd!(h.ctx, { message, user: bob, emoji: "👍" }),
  ).rejects.toThrow("process lost");
  expect(h.kv.get("xp:1")).toBe(100);
  await plugin.events!.reactionAdd!(h.ctx, { message, user: bob, emoji: "👍" });
  expect(h.kv.get("xp:1")).toBe(100);
  expect(h.member("1")!.hasRole("regular")).toBe(true);
  expect(levelUps(h)).toHaveLength(1);
  expect(announcements(h)).toHaveLength(1);
});

test("a redelivered message after a crash replays despite the cooldown", async () => {
  const h = setup({ xpPerMessage: 100 });
  crashOnPublish(h);
  const message = h.receive("general", h.member("1")!.user, "hello there");
  const event = { ...message, member: h.member("1")! };
  await expect(plugin.events!.messageCreate!(h.ctx, event)).rejects.toThrow("process lost");
  await plugin.events!.messageCreate!(h.ctx, event);
  expect(h.kv.get("xp:1")).toBe(100);
  expect(h.member("1")!.hasRole("regular")).toBe(true);
  expect(levelUps(h)).toHaveLength(1);
  expect(announcements(h)).toHaveLength(1);
});

test("role reward failures set a status line instead of being only logged", async () => {
  const h = setup({ xpPerMessage: 0, rewards: [{ level: 1, role: "regular" }] });
  await h.ctx.kv.set("xp:1", 95);
  const failing = await h.ctx.server.member("1");
  h.ctx.server.member = async () =>
    Object.assign(Object.create(failing!), {
      hasRole: () => false,
      addRole: async () => {
        throw new Error("Missing Permissions");
      },
    });
  await plugin.actions!.grantXp!.run(h.ctx, { userId: "1", amount: 5 }, call("r"));
  expect(h.logs.some((l) => l.level === "warn" && l.message.startsWith("role-rewards: "))).toBe(
    true,
  );
});

test("a season reset re-crosses levels once per season with a season-scoped key", async () => {
  const h = setup({ xpPerMessage: 0, season: { id: "s1", end: "2026-11-20T00:00:00Z" } });
  await h.ctx.kv.set("xp:1", 300); // reached level 2 before the season ended
  await h.ctx.kv.set("peak:1", { level: 2 });
  await plugin.actions!.grantXp!.run(h.ctx, { userId: "1", amount: 100 }, call("s"));
  expect(h.kv.get("xp:1")).toBe(100);
  expect(levelUps(h)).toEqual([
    { topic: "levelUp", payload: { userId: "1", level: 1, previous: 0, xp: 100 } },
  ]);
  await plugin.actions!.grantXp!.run(h.ctx, { userId: "1", amount: -5 }, call("t"));
  await plugin.actions!.grantXp!.run(h.ctx, { userId: "1", amount: 5 }, call("u"));
  expect(levelUps(h)).toHaveLength(1);
  expect(h.kv.get("peak:1")).toEqual({ level: 1, season: "s1" });
  expect([...h.kv.keys()].filter((k) => k.startsWith("notice:1:"))).toEqual(["notice:1:1:s1"]);
});

test("a late replay of a lower level-up does not roll reward roles back", async () => {
  const h = setup({
    xpPerMessage: 0,
    rewardMode: "replace",
    rewards: [
      { level: 1, role: "regular" },
      { level: 2, role: "veteran" },
    ],
  });
  await h.ctx.kv.set("xp:1", 95);
  await plugin.actions!.grantXp!.run(h.ctx, { userId: "1", amount: 5 }, call("one"));
  await plugin.actions!.grantXp!.run(h.ctx, { userId: "1", amount: 300 }, call("two"));
  expect(h.member("1")!.hasRole("veteran")).toBe(true);
  await plugin.actions!.grantXp!.run(h.ctx, { userId: "1", amount: 5 }, call("one"));
  expect(h.member("1")!.hasRole("veteran")).toBe(true);
  expect(h.member("1")!.hasRole("regular")).toBe(false);
});
