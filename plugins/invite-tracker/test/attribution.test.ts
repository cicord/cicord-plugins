import { test, expect, vi } from "vite-plus/test";
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
  discarded = false;
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

test("a case-scoped principal cannot read invite records or counts, including its own", async () => {
  const h = createTestContext({ schema, locales: { en, fr } });
  await h.ctx.kv.set("member:2", { inviterId: "15", code: "private" });
  const scope = {
    ...caller,
    onBehalfOf: {
      userId: "2",
      access: "scoped" as const,
      resourceScope: { kind: "case", id: "7" },
    },
  };
  for (const userId of ["2", "15"]) {
    await expect(plugin.queries!.inviterOf!.run(h.ctx, { userId }, scope)).rejects.toMatchObject({
      name: "InteropError",
      code: "denied",
    });
    await expect(plugin.queries!.count!.run(h.ctx, { userId }, scope)).rejects.toMatchObject({
      code: "denied",
    });
  }
  const member = { ...caller, onBehalfOf: { userId: "15", access: "member" as const } };
  await expect(
    plugin.queries!.inviterOf!.run(h.ctx, { userId: "2" }, member),
  ).rejects.toMatchObject({ code: "denied" });
  await expect(plugin.queries!.inviterOf!.run(h.ctx, { userId: "15" }, member)).resolves.toEqual(
    {},
  );
});

// ───────────────────────────── attribution evidence (§5.23: never a guessed attribution)
type Invite = { code: string; uses: number; inviter?: string; maxUses?: number };
function tracker(invites: Invite[]) {
  const h = createTestContext({ locales: { en, fr }, schema, config: { minAccountDays: 0 } });
  const statuses = new Map<string, string | null>();
  h.ctx.status.set = (key, message) => void statuses.set(key, message);
  let denied: Error | undefined;
  h.ctx.server.invites = async () => {
    if (denied) throw denied;
    return invites.map(({ inviter, ...i }) => ({
      ...i,
      ...(inviter ? { inviter: { ...h.ctx.bot.user, id: inviter } } : {}),
    }));
  };
  let n = 100;
  const join = async () => {
    const m = h.addMember({ id: String(++n), joinedAt: new Date() });
    await plugin.events!.memberJoin!(h.ctx, m);
    return plugin.queries!.inviterOf!.run(h.ctx, { userId: m.id }, caller);
  };
  return {
    h,
    statuses,
    join,
    deny: (e?: Error) => (denied = e),
    use: (code: string, by = 1) => (invites.find((i) => i.code === code)!.uses += by),
  };
}
const A = { code: "a", inviterId: "20" },
  B = { code: "b", inviterId: "21" };

test("a leftover use from a missed join is never handed to a later, unrelated join", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const t = tracker([
      { code: "a", uses: 0, inviter: "20" },
      { code: "b", uses: 0, inviter: "21" },
    ]);
    await plugin.onStart!(t.h.ctx);
    t.use("a", 2); // two uses of a, but only one join event arrives
    expect(await t.join()).toEqual(A);
    vi.setSystemTime(Date.now() + 60_000);
    t.use("b");
    expect(await t.join()).toEqual(B); // not the stale use of a
    vi.setSystemTime(Date.now() + 60_000);
    t.use("a", 2);
    expect(await t.join()).toEqual(A);
    vi.setSystemTime(Date.now() + 60_000);
    // A join without any counter evidence (vanity-less link, deleted invite, missed delta).
    expect(await t.join()).toEqual({});
    // Within the evidence window two invites could explain the join: unknown, not a.
    t.use("a", 2);
    expect(await t.join()).toEqual(A);
    t.use("b");
    expect(await t.join()).toEqual({});
    expect(await t.join()).toEqual({});
  } finally {
    vi.useRealTimers();
  }
});

test("simultaneous joins through different invites: only a shared inviter is provable", async () => {
  const t = tracker([
    { code: "a", uses: 0, inviter: "20" },
    { code: "a2", uses: 0, inviter: "20" },
    { code: "b", uses: 0, inviter: "21" },
  ]);
  await plugin.onStart!(t.h.ctx);
  t.use("a");
  t.use("a2");
  // Two codes of one inviter: the inviter is known for both, the code is not.
  expect(await t.join()).toEqual({ inviterId: "20" });
  expect(await t.join()).toEqual({ inviterId: "20" });
  t.use("a");
  t.use("b");
  expect(await t.join()).toEqual({});
  expect(await t.join()).toEqual({});
  expect(t.h.published.map((p) => p.payload)).toEqual([
    { userId: "101", inviterId: "20", fake: false },
    { userId: "102", inviterId: "20", fake: false },
    { userId: "103", fake: false },
    { userId: "104", fake: false },
  ]);
  expect(await plugin.queries!.count!.run(t.h.ctx, { userId: "20" }, caller)).toMatchObject({
    valid: 2,
  });
});

test("a used-up single-use invite makes a concurrent delta ambiguous", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    await usedUp();
  } finally {
    vi.useRealTimers();
  }
});
async function usedUp() {
  const t = tracker([
    { code: "a", uses: 0, inviter: "20" },
    { code: "once", uses: 0, inviter: "22", maxUses: 1 },
    { code: "twice", uses: 0, inviter: "23", maxUses: 2 },
  ]);
  await plugin.onStart!(t.h.ctx);
  // Discord deletes "once" when it is used: the deletion event arrives before the join.
  await plugin.events!.inviteDelete!(t.h.ctx, { code: "once" });
  t.use("a");
  expect(await t.join()).toEqual({});
  expect(await t.join()).toEqual({});
  // The same when the capped invite simply disappears from the listing.
  const t2 = tracker([
    { code: "a", uses: 0, inviter: "20" },
    { code: "b", uses: 0, inviter: "21" },
  ]);
  await plugin.onStart!(t2.h.ctx);
  await plugin.events!.inviteCreate!(t2.h.ctx, { code: "c", uses: 0, maxUses: 1 });
  t2.use("a");
  expect(await t2.join()).toEqual({});
  // Once that evidence window has passed, deleting an unlimited invite consumes no use:
  // later evidence still attributes.
  vi.setSystemTime(Date.now() + 60_000);
  await plugin.events!.inviteDelete!(t2.h.ctx, { code: "b" });
  t2.use("a");
  expect(await t2.join()).toEqual(A);
}

test("without Manage Server the status says so, joins are kept unattributed, and attribution recovers", async () => {
  const invites = [{ code: "a", uses: 0, inviter: "20" }];
  const t = tracker(invites);
  t.deny(new Error("ListInviteUses: discord: missing permissions"));
  await plugin.onStart!(t.h.ctx);
  expect(t.statuses.get("invite-counters")).toMatch(/Manage Server/);
  t.use("a");
  expect(await t.join()).toEqual({});
  expect(t.h.kv.get("member:101")).toMatchObject({ left: false, fake: false });
  expect(t.h.published).toEqual([{ topic: "joined", payload: { userId: "101", fake: false } }]);
  // The permission comes back with a role change: a fresh baseline, the status clears.
  t.deny(undefined);
  await plugin.events!.roleUpdate!(t.h.ctx, {} as never);
  expect(t.statuses.get("invite-counters")).toBeNull();
  t.use("a");
  expect(await t.join()).toEqual(A);
  // Revoked later: the join is still recorded and published.
  t.deny(new Error("discord: missing permissions"));
  t.use("a");
  expect(await t.join()).toEqual({});
  expect(t.statuses.get("invite-counters")).toMatch(/Manage Server/);
  expect(t.h.published.map((p) => p.payload)).toHaveLength(3);
  // A transient failure is reported without blaming the permission.
  t.deny(new Error("upstream timeout"));
  await plugin.events!.serverAvailable!(t.h.ctx);
  expect(t.statuses.get("invite-counters")).toMatch(/could not be read/);
});

test("a join delivered late, from before the current baseline, never takes a newer use", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const t = tracker([
      { code: "a", uses: 0, inviter: "20" },
      { code: "b", uses: 0, inviter: "21" },
    ]);
    const early = t.h.addMember({ id: "90", joinedAt: new Date(Date.now() - 60_000) });
    await plugin.onStart!(t.h.ctx); // the baseline already counts that member's use
    t.use("b");
    await plugin.events!.memberJoin!(t.h.ctx, early);
    expect(await plugin.queries!.inviterOf!.run(t.h.ctx, { userId: "90" }, caller)).toEqual({});
    expect(await t.join()).toEqual(B);
  } finally {
    vi.useRealTimers();
  }
});

test("the bot regaining its permissions through a member update resumes attribution", async () => {
  const t = tracker([{ code: "a", uses: 0, inviter: "20" }]);
  t.deny(new Error("discord: missing permissions"));
  await plugin.onStart!(t.h.ctx);
  t.deny(undefined);
  const bot = t.h.addMember({ id: t.h.ctx.bot.user.id });
  await plugin.events!.memberUpdate!(t.h.ctx, bot, {} as never);
  expect(t.statuses.get("invite-counters")).toBeNull();
  t.use("a");
  expect(await t.join()).toEqual(A);
});
