import { createTestContext } from "@cicord/sdk/testing";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import en from "../locales/en.json" with { type: "json" };
import schema from "../config.schema.json" with { type: "json" };
import plugin from "../src/index.ts";

function setup(features: string[] = ["privacyCopies"]) {
  return createTestContext({
    schema,
    locales: { en },
    features,
    config: { xpPerMessage: 100, reactionXp: 5, announce: { channel: "chat" } },
    members: [{ id: "1" }, { id: "2" }, { id: "3" }],
    channels: { chat: { name: "Chat" } },
  });
}
type Harness = ReturnType<typeof setup>;

async function activity(h: Harness) {
  const said: Record<string, ReturnType<Harness["receive"]>> = {};
  for (const uid of ["1", "2"]) {
    said[uid] = h.receive("chat", h.member(uid)!.user, "hello there");
    await plugin.events!.messageCreate!(h.ctx, { ...said[uid]!, member: h.member(uid)! });
  }
  // 1 reacts to 2, 2 and 3 react to 1.
  await plugin.events!.reactionAdd!(h.ctx, {
    message: said["2"]!,
    user: h.member("1")!.user,
    emoji: "👍",
  });
  for (const uid of ["2", "3"])
    await plugin.events!.reactionAdd!(h.ctx, {
      message: said["1"]!,
      user: h.member(uid)!.user,
      emoji: "🔥",
    });
  return said;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-21T12:00:00Z"));
});
afterEach(() => vi.useRealTimers());

test("export and erase read only the member's own keys and indexes, never the whole KV", async () => {
  const h = setup();
  const said = await activity(h);
  // Unrelated rows of other members, as a large server has.
  for (let i = 0; i < 50; i++) await h.ctx.kv.set("msg:other" + i, "2");
  const list = h.ctx.kv.list.bind(h.ctx.kv);
  const prefixes: (string | undefined)[] = [];
  h.ctx.kv.list = ((options?: { prefix?: string }) => {
    prefixes.push(options?.prefix);
    return list(options);
  }) as typeof h.ctx.kv.list;
  const exported = (await plugin.privacy!.export(h.ctx, "1")) as { key: string }[];
  const keys = exported.map((r) => r.key);
  expect(keys).toEqual(
    expect.arrayContaining([
      "xp:1",
      "peak:1",
      "msg:" + said["1"]!.id,
      "reaction:" + said["2"]!.id + ":1",
      "day:2026-11-21:1",
    ]),
  );
  expect(keys.some((k) => k.startsWith("award:1:"))).toBe(true);
  expect(keys.some((k) => k.startsWith("copy:1:"))).toBe(true);
  expect(keys.every((k) => !k.startsWith("xp:2") && k !== "msg:" + said["2"]!.id)).toBe(true);
  await plugin.privacy!.erase(h.ctx, "1");
  expect(prefixes.length).toBeGreaterThan(0);
  for (const prefix of prefixes) {
    expect(prefix).toBeDefined();
    expect(prefix).not.toBe("msg:");
    expect(
      /^(award|notice|copy|archived|by):1:/.test(prefix!) ||
        /^(reaction|react):[^:]+:/.test(prefix!) ||
        prefix === "pending-copies:",
    ).toBe(true);
  }
});

test("two members: an export holds only the subject's own rows, never the reactions others gave", async () => {
  const h = setup();
  const said = await activity(h);
  const keysOf = async (uid: string) =>
    ((await plugin.privacy!.export(h.ctx, uid)) as { key: string }[]).map((r) => r.key);
  const one = await keysOf("1");
  // 2 and 3 reacted to 1's message: their records are theirs, not 1's.
  expect(one).not.toContain("reaction:" + said["1"]!.id + ":2");
  expect(one).not.toContain("reaction:" + said["1"]!.id + ":3");
  expect(one.filter((k) => /^(reaction|react):[^:]+:(?!1(:|$))/.test(k))).toEqual([]);
  expect(one).toContain("reaction:" + said["2"]!.id + ":1");
  const two = await keysOf("2");
  // 2's export has the reaction it gave to 1, and not the one 1 gave to 2's message.
  expect(two).toContain("reaction:" + said["1"]!.id + ":2");
  expect(two).not.toContain("reaction:" + said["2"]!.id + ":1");
  expect(two.filter((k) => k.startsWith("reaction:") && !k.endsWith(":2"))).toEqual([]);
  // The erasure still removes the reactions that reference the erased member's message.
  await plugin.privacy!.erase(h.ctx, "1");
  expect([...h.kv.keys()]).not.toContain("reaction:" + said["1"]!.id + ":3");
});

test("two members: erasing one removes its data and references and keeps the other's", async () => {
  const h = setup();
  const said = await activity(h);
  const before2 = h.kv.get("xp:2");
  await plugin.privacy!.erase(h.ctx, "1");
  expect(await plugin.privacy!.export(h.ctx, "1")).toEqual([]);
  const left = [...h.kv.keys()];
  const ofMember = (k: string) =>
    /^(xp|user|cooldown|voice|peak):1$/.test(k) ||
    /^(award|notice|copy|archived|by):1:/.test(k) ||
    /^(day|reaction|react):[^:]+:1(:|$)/.test(k);
  expect(left.filter(ofMember)).toEqual([]);
  expect([...h.kv.keys()].filter((k) => k.startsWith("by:2:"))).not.toEqual([]);
  expect(left).not.toContain("msg:" + said["1"]!.id);
  expect(left).not.toContain("reaction:" + said["1"]!.id + ":2");
  expect(h.kv.get("xp:2")).toBe(before2);
  expect(h.kv.get("msg:" + said["2"]!.id)).toBe("2");
  expect(await h.ctx.kv.ranking("xp").score("1")).toBeUndefined();
  expect(await h.ctx.kv.ranking("xp").score("2")).toBe(before2);
  expect(((await plugin.privacy!.export(h.ctx, "2")) as unknown[]).length).toBeGreaterThan(0);
  expect(h.message(h.sent[0]!.id)!.content).toBe(en.erased);
  expect(h.message(h.sent[1]!.id)!.content).toContain("<@2>");
});

test("erase without privacyCopies erases the KV data and reports the announcement it could not redact", async () => {
  const h = setup([]);
  await activity(h);
  const result = await plugin.privacy!.erase(h.ctx, "1");
  expect(result.erased).toBeGreaterThan(0);
  expect(h.kv.get("xp:1")).toBeUndefined();
  expect(await h.ctx.kv.ranking("xp").score("1")).toBeUndefined();
  expect(h.message(h.sent[0]!.id)!.content).toContain("<@1>");
  expect(h.logs.some((l) => l.level === "warn" && l.message.startsWith("privacy-copies: "))).toBe(
    true,
  );
  // The reference is kept so a later erasure with the grant can redact it.
  expect([...h.kv.keys()].filter((k) => k.startsWith("copy:1:"))).toHaveLength(1);
});

test("the privacy-copies line stays while any erased member still has unredacted copies", async () => {
  const h = setup([]);
  await activity(h);
  const reports = () => h.logs.filter((l) => l.message.startsWith("privacy-copies: ")).length;
  await plugin.privacy!.erase(h.ctx, "1");
  expect(reports()).toBe(1);
  await h.ctx.kv.set("xp:3", 10);
  await plugin.privacy!.erase(h.ctx, "3"); // nothing published: must not clear 1's report
  expect(reports()).toBe(2);
  // With the grant, repeating 1's erasure redacts the copy and clears the line.
  const granted = h.ctx.features.enabled;
  h.ctx.features.enabled = (name: string) => name === "privacyCopies" || granted(name);
  await plugin.privacy!.erase(h.ctx, "1");
  expect(h.message(h.sent[0]!.id)!.content).toBe(en.erased);
  expect(
    [...h.kv.keys()].filter((k) => k.startsWith("pending-copies:") || k.startsWith("copy:1:")),
  ).toEqual([]);
  expect(reports()).toBe(2);
});
