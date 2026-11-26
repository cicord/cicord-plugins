import { test, expect } from "vite-plus/test";
import { createTestContext } from "@cicord/sdk/testing";
import plugin from "../src/index.ts";
import en from "../locales/en.json" with { type: "json" };
import fr from "../locales/fr.json" with { type: "json" };
import schema from "../config.schema.json" with { type: "json" };
const caller = {
  caller: { bot: "bot", instance: "welcome", plugin: "welcome", source: "cicord", verified: true },
};
test("shared invite deltas survive concurrent handlers; new and ambiguous codes never identify a member", async () => {
  const invites = [
    { code: "a", uses: 0, inviter: { id: "20" } },
    { code: "b", uses: 0, inviter: { id: "21" } },
  ];
  const t = createTestContext({
    locales: { en, fr },
    schema,
    config: { minAccountDays: 0 },
    members: [1, 2, 3, 4, 5].map((n) => ({ id: String(n), joinedAt: new Date() })),
  });
  t.ctx.server.invites = async () =>
    invites.map((i) => ({ ...i, inviter: { ...t.member("1")!.user, id: i.inviter.id } }));
  await plugin.onStart!(t.ctx);
  invites[0]!.uses = 2;
  await Promise.all(["1", "2"].map((id) => plugin.events!.memberJoin!(t.ctx, t.member(id)!)));
  const q = (id: string) => plugin.queries!.inviterOf!.run(t.ctx, { userId: id }, caller);
  expect(await q("1")).toEqual({ inviterId: "20", code: "a" });
  expect(await q("2")).toEqual(await q("1"));
  invites.push({ code: "during-outage", uses: 1, inviter: { id: "22" } });
  await plugin.events!.memberJoin!(t.ctx, t.member("3")!);
  expect(await q("3")).toEqual({});
  invites[0]!.uses++;
  invites[1]!.uses++;
  await Promise.all(["4", "5"].map((id) => plugin.events!.memberJoin!(t.ctx, t.member(id)!)));
  expect(await q("4")).toEqual({});
  expect(await q("5")).toEqual({});
  await plugin.events!.memberLeave!(t.ctx, t.member("1")!.user);
  expect(await plugin.queries!.count!.run(t.ctx, { userId: "20" }, caller)).toEqual({
    valid: 1,
    fake: 1,
    left: 1,
  });
});

test("a legacy backfill survives a crash, overlapping restarts and live mutations; ready reads use only indexes", async () => {
  const h = createTestContext({ schema, locales: { en, fr } });
  for (let i = 0; i < 90; i++) {
    await h.ctx.kv.set("member:" + String(1000 + i), {
      at: 0,
      inviterId: i % 2 ? "21" : "20",
      fake: i === 0,
      left: false,
    });
  }
  const after = h.ctx.schedule.after.bind(h.ctx.schedule);
  let discarded = false;
  h.ctx.schedule.after = async (...args) => {
    if (!discarded) {
      discarded = true;
      throw new Error("durable queue unavailable");
    }
    return after(...args);
  };
  await expect(plugin.onStart!(h.ctx)).rejects.toThrow("unavailable");
  expect(h.kv.has("index:v1:progress")).toBe(false);
  await plugin.onStart!(h.ctx);
  discarded=false;
  await expect(plugin.tasks!.migrate!(h.ctx, undefined)).rejects.toThrow("unavailable");
  expect(h.kv.get("index:v1:progress")).toMatchObject({ ready: false, processed: 16 });
  await expect(plugin.queries!.count!.run(h.ctx, { userId: "20" }, caller)).rejects.toThrow(
    "index",
  );
  await plugin.events!.memberLeave!(h.ctx, h.addMember({ id: "1089" }).user);
  for (let k = 0; k < 6; k++)
    await Promise.all([
      plugin.tasks!.migrate!(h.ctx, undefined),
      plugin.tasks!.migrate!(h.ctx, undefined),
    ]);
  expect(h.kv.get("index:v1:progress")).toMatchObject({ ready: true, processed: 90 });
  await plugin.onStart!(h.ctx);
  const list = h.ctx.kv.list.bind(h.ctx.kv);
  h.ctx.kv.list = async (opts) => {
    if (opts?.prefix === "member:") throw new Error("unexpected member scan");
    return list(opts) as never;
  };
  expect(await plugin.queries!.count!.run(h.ctx, { userId: "20" }, caller)).toEqual({
    valid: 44,
    fake: 1,
    left: 0,
  });
  expect(await plugin.queries!.count!.run(h.ctx, { userId: "21" }, caller)).toEqual({
    valid: 44,
    fake: 0,
    left: 1,
  });
  const route = plugin.routes!["GET /leaderboard"]!;
  const req = {
    body: undefined,
    params: {},
    query: { limit: "1", offset: "1" },
    method: "GET" as const,
    path: "/leaderboard",
  };
  expect(await route.handler(h.ctx, req)).toEqual([{ userId: "21", valid: 44, fake: 0, left: 1 }]);
  await plugin.privacy!.erase(h.ctx, "20");
  expect(await plugin.queries!.count!.run(h.ctx, { userId: "20" }, caller)).toEqual({
    valid: 0,
    fake: 0,
    left: 0,
  });
  expect(await plugin.queries!.count!.run(h.ctx, { userId: "21" }, caller)).toEqual({
    valid: 44,
    fake: 0,
    left: 1,
  });
});
