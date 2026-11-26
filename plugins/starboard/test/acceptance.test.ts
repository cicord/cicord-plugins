import { describe, expect, it } from "vite-plus/test";
import { createTestContext, runCommand, type TestHarness } from "@cicord/sdk/testing";
import type { Context, KVAtomic, Message } from "@cicord/sdk";
import plugin, { sync } from "../src/index.ts";
import schema from "../config.schema.json" with { type: "json" };
import en from "../locales/en.json" with { type: "json" };

// Members 11 and 12 are regular members; only 11 holds the crew role that reads #staff.
function harness(config: Record<string, unknown>) {
  const visible = ["ViewChannel", "ReadMessageHistory"] as const;
  const crewOnly = {
    "@everyone": { deny: [...visible] },
    crew: { allow: [...visible] },
  };
  return createTestContext({
    schema,
    config: { threshold: 1, ...config },
    locales: { en },
    roles: { crew: { name: "crew" } },
    members: [{ id: "10" }, { id: "11", roles: ["crew"] }, { id: "12" }, { id: "13" }],
    server: { ownerId: "10", everyonePermissions: [...visible] },
    channels: {
      general: { name: "general" },
      stars: { name: "stars" },
      staff: { name: "staff", overwrites: crewOnly },
      "staff-stars": { name: "staff-stars", overwrites: crewOnly },
      lounge: { name: "lounge", nsfw: true },
      "lounge-stars": { name: "lounge-stars", nsfw: true },
    },
  });
}
async function post(h: TestHarness, channel: string, author: string, text: string) {
  return h.receive(h.channel(channel)!.id, h.member(author)!.user, text);
}
async function star(h: TestHarness, m: Message, uid: string, ctx: Context = h.ctx) {
  h.setReaction(m.id, "⭐", uid);
  await plugin.events!.reactionAdd!(ctx, { message: m, user: h.member(uid)!.user, emoji: "⭐" });
}
const copies = (h: TestHarness, channel: string) =>
  h.sent.filter((s) => s.to === channel || s.to === h.channel(channel)!.id);
const top = async (h: TestHarness, user: string) =>
  (await runCommand(plugin, h, "starboard top", { user, channel: "general" })).replies;

describe("audience (P8)", () => {
  it("never republishes a private source to a public board, even when mapped", async () => {
    for (const boards of [[], [{ sources: ["staff"], channel: "stars" }]]) {
      const h = harness({ channel: "stars", boards });
      const m = await post(h, "staff", "11", "Staff review details");
      expect(h.member("11")!.canView("staff")).toBe(true);
      expect(h.member("12")!.canView("staff")).toBe(false);
      await star(h, m, "10");
      await star(h, m, "13");
      await sync(h.ctx, m.id);
      expect(copies(h, "stars")).toHaveLength(0);
      expect(h.kv.has("star:" + m.id)).toBe(false);
      expect(JSON.stringify(h.sent)).not.toContain("Staff review details");
      expect(await top(h, "12")).toEqual([en.empty]);
    }
  });

  it("publishes a private source only to its own private board, readable by its members", async () => {
    const h = harness({ channel: "stars", boards: [{ sources: ["staff"], channel: "staff-stars" }] });
    const m = await post(h, "staff", "10", "Staff review details");
    await star(h, m, "11");
    await sync(h.ctx, m.id);
    expect(copies(h, "staff-stars")).toHaveLength(1);
    expect(copies(h, "stars")).toHaveLength(0);
    expect((await top(h, "11"))[0]).toContain(copies(h, "staff-stars")[0]!.id);
    expect(await top(h, "12")).toEqual([en.empty]);
  });

  it("removes the copy when a public source becomes private", async () => {
    const h = harness({ channel: "stars" });
    // Only channels this instance created can be edited in the harness.
    const source = await h.ctx.server.createChannel({ name: "original", type: "text" });
    const m = h.receive(source.id, h.member("11")!.user, "Summer festival");
    await star(h, m, "12");
    await sync(h.ctx, m.id);
    const [copy] = copies(h, "stars");
    expect(copy).toBeDefined();
    expect((await top(h, "12"))[0]).toContain(copy!.id);
    await h.ctx.server.editChannel(source, {
      overwrites: { "@everyone": { deny: ["ViewChannel"] }, crew: { allow: ["ViewChannel"] } },
    });
    await sync(h.ctx, m.id);
    expect(await h.channel("stars")!.message(copy!.id)).toBeUndefined();
    expect(h.kv.has("star:" + m.id)).toBe(false);
    expect(await top(h, "11")).toEqual([en.empty]);
  });

  it("never copies an age-restricted source to a board that is not age-restricted", async () => {
    for (const boards of [[], [{ sources: ["lounge"], channel: "stars" }]]) {
      const h = harness({ channel: "stars", boards });
      const m = await post(h, "lounge", "11", "Late night thread");
      await star(h, m, "12");
      await sync(h.ctx, m.id);
      expect(copies(h, "stars")).toHaveLength(0);
    }
    const h = harness({ channel: "stars", boards: [{ sources: ["lounge"], channel: "lounge-stars" }] });
    const m = await post(h, "lounge", "11", "Late night thread");
    await star(h, m, "12");
    await sync(h.ctx, m.id);
    expect(copies(h, "lounge-stars")).toHaveLength(1);
  });
});

/** A context whose next KV commit after a board message is sent throws, like a crash. */
function crashAfterSend(h: TestHarness, board: string): { ctx: Context; crashed: () => boolean } {
  let crashed = false;
  const sentBefore = copies(h, board).length;
  const wrap = (b: KVAtomic): KVAtomic => {
    const proxy: KVAtomic = new Proxy(b, {
      get(target, prop) {
        if (prop === "commit")
          return async () => {
            if (!crashed && copies(h, board).length > sentBefore) {
              crashed = true;
              throw new Error("process killed");
            }
            return target.commit();
          };
        const value = Reflect.get(target, prop) as unknown;
        return typeof value === "function"
          ? (...args: unknown[]) => {
              (value as (...a: unknown[]) => unknown).apply(target, args);
              return proxy;
            }
          : value;
      },
    });
    return proxy;
  };
  const kv = new Proxy(h.ctx.kv, {
    get(target, prop) {
      if (prop === "atomic") return () => wrap(target.atomic());
      const value = Reflect.get(target, prop) as unknown;
      return typeof value === "function" ? (value as () => unknown).bind(target) : value;
    },
  });
  const ctx = new Proxy(h.ctx, {
    get: (target, prop) => (prop === "kv" ? kv : Reflect.get(target, prop)),
  });
  return { ctx, crashed: () => crashed };
}

describe("publication replay", () => {
  it("publishes once after a restart between the Discord send and the KV commit", async () => {
    const h = harness({ channel: "stars" });
    const m = await post(h, "general", "11", "Summer festival");
    await star(h, m, "12");
    const crash = crashAfterSend(h, "stars");
    await expect(sync(crash.ctx, m.id)).rejects.toThrow("process killed");
    expect(crash.crashed()).toBe(true);
    const [first] = copies(h, "stars");
    expect(first).toBeDefined();
    const pending = h.kv.get("star:" + m.id) as { copyId?: string; pendingAt?: number };
    expect(pending.copyId).toBeUndefined();
    expect(pending.pendingAt).toBeTypeOf("number");

    // Restart: the replay finds the marked copy and edits it instead of sending again (the
    // stable nonce is only the second line of defence).
    await sync(h.ctx, m.id);
    expect(h.edits.map((e) => e.id)).toEqual([first!.id]);
    await sync(h.ctx, m.id);
    expect(copies(h, "stars")).toHaveLength(1);
    expect((h.kv.get("star:" + m.id) as { copyId?: string }).copyId).toBe(first!.id);
    expect(h.published.filter((p) => p.topic === "starred")).toHaveLength(1);
    expect(await h.ctx.kv.ranking("stars").score(m.id)).toBe(1);
  });
});

describe("privacy erase", () => {
  it("erases one member's highlights, copies and ranking entries and keeps the other's", async () => {
    const h = harness({ channel: "stars" });
    const a = await post(h, "general", "11", "Alice's highlight");
    const b = await post(h, "general", "12", "Bob's highlight");
    await star(h, a, "13");
    await star(h, b, "13");
    await sync(h.ctx, a.id);
    await sync(h.ctx, b.id);
    const [copyA, copyB] = copies(h, "stars");
    // A third message of member 11 is starred but still inside the coalescing window. The
    // reaction event carries a partial message without its author.
    const pending = await post(h, "general", "11", "Alice's pending highlight");
    h.setReaction(pending.id, "⭐", "13");
    await plugin.events!.reactionAdd!(h.ctx, {
      message: { id: pending.id, channel: pending.channel } as Message,
      user: h.member("13")!.user,
      emoji: "⭐",
    });
    expect(h.kv.has("star:" + pending.id)).toBe(true);

    expect(await h.eraseMember(plugin, "11")).toEqual({ erased: 2 });
    expect(await h.channel("stars")!.message(copyA!.id)).toBeUndefined();
    expect(await h.channel("stars")!.message(copyB!.id)).toBeDefined();
    expect(h.kv.has("star:" + a.id)).toBe(false);
    expect(h.kv.has("star:" + pending.id)).toBe(false);
    expect((await h.ctx.kv.ranking("stars").top()).map((r) => r.member)).toEqual([b.id]);
    expect(await plugin.privacy!.export(h.ctx, "11")).toEqual([]);
    expect(await plugin.privacy!.export(h.ctx, "12")).toEqual([{ messageId: b.id, stars: 1 }]);

    // The refresh queued before the erasure finds nothing to publish.
    await sync(h.ctx, pending.id);
    expect(copies(h, "stars")).toHaveLength(2);
    expect(JSON.stringify(h.sent.slice(2))).not.toContain("Alice");
  });
});
