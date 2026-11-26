import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import {
  callRoute,
  createTestContext,
  runCommand,
  runComponent,
  submitModal,
} from "@cicord/sdk/testing";
import type { Json, MessageInput } from "@cicord/sdk";
import schema from "../config.schema.json" with { type: "json" };
import en from "../locales/en.json" with { type: "json" };
import fr from "../locales/fr.json" with { type: "json" };
// The providers' real contracts: the runtime validates every provider output against them.
import memberLevel from "../../levels/contracts/memberLevel.v1.json" with { type: "json" };
import inviteCount from "../../invite-tracker/contracts/count.v1.json" with { type: "json" };
import standing from "../../moderation/contracts/standing.v1.json" with { type: "json" };
import grantXp from "../../levels/contracts/grantXp.v1.json" with { type: "json" };
import plugin from "../src/index.ts";
import { entrantsHash } from "../src/draw.ts";
import { fetchDraw, verify } from "./verify.mjs";

type Schema = {
  type?: string | string[];
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean;
  minimum?: number;
  minLength?: number;
};
/** The JSON Schema subset these contracts use. */
function valid(s: Schema, v: unknown): boolean {
  const kind =
    v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v;
  const types = s.type === undefined ? [] : ([] as string[]).concat(s.type);
  if (types.length && !types.includes(kind) && !(kind === "integer" && types.includes("number")))
    return false;
  if (typeof v === "number" && s.minimum !== undefined && v < s.minimum) return false;
  if (typeof v === "string" && s.minLength !== undefined && v.length < s.minLength) return false;
  if (kind !== "object") return true;
  const o = v as Record<string, unknown>;
  return (
    (s.required ?? []).every((r) => r in o) &&
    Object.entries(o).every(([k, val]) =>
      s.properties?.[k] ? valid(s.properties[k], val) : s.additionalProperties !== false,
    )
  );
}

const HOST = "99";
const ids = Array.from({ length: 60 }, (_, i) => String(1001 + i));
type Provider = { query?: (method: string, input: Json) => Json; has?: (p: string) => boolean };
function setup(
  config: Record<string, unknown> = {},
  provider: Provider = {},
  features: string[] = [],
) {
  const h = createTestContext({
    schema,
    locales: { en, fr },
    config: { enabled: true, ...config },
    features,
    server: { ownerId: HOST, everyonePermissions: ["ViewChannel", "ReadMessageHistory"] },
    roles: { vip: { name: "VIP" }, banned: { name: "Banned" } },
    channels: { lobby: { name: "Lobby" } },
    members: [
      { id: HOST },
      ...ids.map((id) => ({ id, joinedAt: new Date(Date.now() - 30 * 86400000) })),
    ],
  });
  const calls: { plugin: string; method: string; input: Json; key: string }[] = [];
  const statuses = new Map<string, string | null>();
  h.ctx.status.set = (k, m) => void statuses.set(k, m);
  Object.assign(h.ctx, {
    plugins: {
      has: provider.has ?? (() => true),
      hasFeature: () => false,
      async query(_plugin: string, method: string, input: Json) {
        if (!provider.query) throw new Error("no provider");
        return provider.query(method, input);
      },
      async call(p: string, method: string, input: Json, opts: { idempotencyKey: string }) {
        calls.push({ plugin: p, method, input, key: opts.idempotencyKey });
        return p === "levels" ? { xp: 1 } : p === "economy" ? { balance: 1 } : {};
      },
    },
  });
  return { h, calls, statuses };
}
type H = ReturnType<typeof setup>["h"];

/** /giveaway start → modal → the start task, as in production. Returns the giveaway id. */
async function launch(h: H, winners = 1, seconds = 3600) {
  const r = await runCommand(plugin, h, "giveaway start", {
    user: HOST,
    channel: "lobby",
    options: { seconds, winners },
  });
  expect(r.modal, JSON.stringify(r.replies)).toBeDefined();
  await submitModal(plugin, h, r.modal!.id, {
    user: HOST,
    channel: "lobby",
    fields: { prize: "Book" },
  });
  // The harness interaction id is not a snowflake (production ids are): re-key the record
  // the modal created under a snowflake of the current time.
  const created = [...h.kv.keys()].find((k) => k.startsWith("gw:interaction"))!;
  const id = (((BigInt(Date.now()) - 1420070400000n) << 22n) | BigInt(++launched)).toString();
  await h.ctx.kv.set("gw:" + id, { ...(h.kv.get(created) as Record<string, Json>), id });
  await h.ctx.kv.delete(created);
  await plugin.tasks!.start!(h.ctx, { id });
  return id;
}
let launched = 0;
const enter = (h: H, id: string, user: string) =>
  runComponent(plugin, h, "enter:" + id, { user, channel: "lobby" });
const reply = (r: { replies: unknown[] }) => {
  const x = r.replies[0] as string | { content?: string };
  return typeof x === "string" ? x : x.content;
};
const record = (h: H, id: string) =>
  h.kv.get("gw:" + id) as {
    state: string;
    winners: string[];
    history: string[];
    claimed: string[];
    round: number;
    entrants: number;
    claimBy: number;
    seed: string;
  };
const entrantsField = (m: MessageInput) =>
  (m as { embeds: { fields: { name: string; value: string }[] }[] }).embeds[0]!.fields.find(
    (f) => f.name === "Entrants",
  )!.value;
const lastPanel = (h: H) => h.edits.at(-1)?.message ?? h.sent.at(-1)!.message;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.parse("2030-05-01T12:00:00Z"));
});
afterEach(() => vi.useRealTimers());

test("claim, claim expiry and reroll redraws never include a previous winner, under replay", async () => {
  const { h, calls } = setup({ claim: { enabled: true, hours: 1 }, rewards: { xp: 50 } }, {}, [
    "xpReward",
  ]);
  const id = await launch(h, 2);
  for (const u of ids.slice(0, 6))
    expect(reply(await enter(h, id, u))).toBe("Your entry is recorded.");
  vi.setSystemTime(Date.now() + 3600 * 1000);
  await plugin.tasks!.finish!(h.ctx, { id });
  await plugin.tasks!.finish!(h.ctx, { id }); // replayed deadline
  const first = record(h, id);
  expect(first).toMatchObject({ state: "ended", round: 1, entrants: 6 });
  expect(first.winners).toHaveLength(2);
  expect(calls).toEqual([]); // rewards wait for the claim
  const [claimer, idle] = first.winners as [string, string];
  const loser = ids.slice(0, 6).find((u) => !first.winners.includes(u))!;
  expect(reply(await runComponent(plugin, h, "claim:" + id, { user: loser }))).toBe(
    "There is no open prize for you.",
  );
  for (let i = 0; i < 2; i++)
    expect(reply(await runComponent(plugin, h, "claim:" + id, { user: claimer }))).toBe(
      "Your prize has been claimed.",
    );
  expect(record(h, id).claimed).toEqual([claimer]);
  const reward = { plugin: "levels", method: "grantXp", key: `gw:${id}:${claimer}:grantXp` };
  expect(calls).toEqual([expect.objectContaining(reward), expect.objectContaining(reward)]);
  expect(valid(grantXp.input as Schema, calls[0]!.input)).toBe(true);

  // The unclaimed prize is redrawn automatically once the claim window closes.
  const expiry = h.scheduled.find((s) => s.task === "expire")!;
  await plugin.tasks!.expire!(h.ctx, expiry.payload); // early delivery: nothing happens
  expect(record(h, id).round).toBe(1);
  vi.setSystemTime(first.claimBy + 1);
  await plugin.tasks!.expire!(h.ctx, expiry.payload);
  await plugin.tasks!.expire!(h.ctx, expiry.payload); // replayed
  const second = record(h, id);
  expect(second.round).toBe(2);
  expect(second.history).toHaveLength(3);
  expect(second.history.slice(0, 2)).toEqual(first.history);
  expect(second.winners[0]).toBe(claimer);
  expect(first.history).not.toContain(second.winners[1]);
  expect(second.winners).not.toContain(idle);
  // The redraw continues the published sequence: an independent verifier reproduces it.
  const all = ids.slice(0, 6).map((userId) => ({ userId, weight: 1 }));
  expect(
    verify({ seed: first.seed, id, entries: all, count: 1, previous: first.history }).winners,
  ).toEqual([second.winners[1]]);

  // A manual reroll replaces the unclaimed winner only, again excluding every earlier winner.
  const reroll = await runCommand(plugin, h, "giveaway reroll", { user: HOST, options: { id } });
  expect(reply(reroll)).toBe("Giveaway saved.");
  const third = record(h, id);
  expect(third.round).toBe(3);
  expect(third.winners).toEqual([claimer, third.history[3]]);
  expect(new Set(third.history).size).toBe(4);
  // A stale expiry of an earlier round is ignored.
  await plugin.tasks!.expire!(h.ctx, expiry.payload);
  expect(record(h, id).round).toBe(3);
});

test("a refused entry names the unmet condition, including a provider that vanished", async () => {
  const recent = ((BigInt(Date.parse("2030-04-30T00:00:00Z")) - 1420070400000n) << 22n).toString();
  const outputs: Record<string, Json> = {
    memberLevel: { xp: 40, level: 2, rank: null },
    count: { valid: 1, fake: 0, left: 0 },
    standing: { activeWarnings: 1, quarantined: false },
  };
  expect(valid(memberLevel.output as Schema, outputs.memberLevel)).toBe(true);
  expect(valid(inviteCount.output as Schema, outputs.count)).toBe(true);
  expect(valid(standing.output as Schema, outputs.standing)).toBe(true);
  const cases: [Record<string, unknown>, string, string][] = [
    [{ requiredRole: "vip" }, "1001", "You need the required role."],
    [{ excludedRoles: ["banned"] }, "1002", "You have an excluded role."],
    [{ accountDays: 30 }, recent, "Your account is too new."],
    [{ memberDays: 60 }, "1001", "You joined the server too recently."],
    [{ level: 5 }, "1001", "Your level is too low."],
    [{ invites: 3 }, "1001", "You need more valid invites."],
    [{ noWarnings: true }, "1001", "Active warnings prevent entry."],
  ];
  for (const [conditions, user, message] of cases) {
    const { h } = setup({ conditions }, { query: (m) => outputs[m]! }, [
      "level",
      "invites",
      "standing",
    ]);
    if (user === recent) h.addMember({ id: recent, joinedAt: new Date(0) });
    await h.member("1002")!.addRole("banned");
    const id = await launch(h);
    expect(reply(await enter(h, id, user)), JSON.stringify(conditions)).toBe(message);
    expect(h.kv.has(`entry:${id}:${user}`)).toBe(false);
    // The same member passes once the condition holds.
    if (conditions.level) {
      outputs.memberLevel = { xp: 900, level: 5, rank: 3 };
      expect(reply(await enter(h, id, user))).toBe("Your entry is recorded.");
    }
  }
  // Bound at launch, then unbound or failing: the refusal names the condition, not "interop".
  let bound = true,
    failing = false;
  const { h } = setup(
    { conditions: { level: 1 } },
    {
      has: () => bound,
      query: () => {
        if (failing) throw new Error("provider timed out");
        return { xp: 0, level: 3, rank: null };
      },
    },
    ["level"],
  );
  const id = await launch(h);
  failing = true;
  expect(reply(await enter(h, id, "1003"))).toBe("Condition cannot be verified: minimum level.");
  bound = false;
  expect(reply(await enter(h, id, "1003"))).toBe("Condition cannot be verified: minimum level.");
  const french = setup({ conditions: { level: 1 }, locale: "fr" }, { has: () => true }, ["level"]);
  const gid = await launch(french.h);
  expect(reply(await enter(french.h, gid, "1003"))).toBe(
    "Condition invérifiable : niveau minimum.",
  );
});

test("cancel closes an open giveaway: no draw, entries refused, panel frozen", async () => {
  const { h } = setup();
  const id = await launch(h);
  await enter(h, id, "1001");
  await enter(h, id, "1002");
  expect(
    reply(await runCommand(plugin, h, "giveaway cancel", { user: HOST, options: { id } })),
  ).toBe("Giveaway saved.");
  expect(record(h, id)).toMatchObject({ state: "cancelled", entrants: 2, winners: [] });
  expect(h.kv.has("entrants:" + id)).toBe(false);
  const panel = lastPanel(h);
  expect((panel as { components: unknown[] }).components).toEqual([]);
  expect(entrantsField(panel)).toBe("2");
  expect(reply(await enter(h, id, "1003"))).toBe("This giveaway is closed.");
  await plugin.tasks!.finish!(h.ctx, { id });
  expect(record(h, id)).toMatchObject({ state: "cancelled", round: 0, history: [] });
  expect(h.published.map((p) => p.topic)).toEqual(["started"]);
});

test("missing reward providers are reported, then cleared once a payout succeeds", async () => {
  let bound = false;
  const { h, calls, statuses } = setup({ rewards: { xp: 10 } }, { has: () => bound }, ["xpReward"]);
  await plugin.onStart!(h.ctx);
  expect(statuses.get("reward-xpReward")).toBe("Reward unavailable: levels.grantXp");
  const id = await launch(h);
  await enter(h, id, "1001");
  vi.setSystemTime(Date.now() + 3600 * 1000);
  await plugin.tasks!.finish!(h.ctx, { id });
  expect(calls).toEqual([]);
  expect(statuses.get("reward-xpReward")).toBe("Reward unavailable: levels.grantXp");
  bound = true;
  const second = await launch(h, 1);
  await enter(h, second, "1002");
  vi.setSystemTime(Date.now() + 3600 * 1000);
  await plugin.tasks!.finish!(h.ctx, { id: second });
  expect(calls).toEqual([
    expect.objectContaining({
      plugin: "levels",
      method: "grantXp",
      key: `gw:${second}:1002:grantXp`,
    }),
  ]);
  expect(statuses.get("reward-xpReward")).toBeNull();
});

/** Counts failed commits of transactions that write an entry key. */
function conflicts(h: H) {
  const atomic = h.ctx.kv.atomic.bind(h.ctx.kv),
    stats = { failed: 0, committed: 0 };
  h.ctx.kv.atomic = () => {
    const tx = atomic();
    let entry = false;
    const set = tx.set.bind(tx),
      del = tx.delete.bind(tx),
      commit = tx.commit.bind(tx);
    tx.set = (k, ...rest) => ((entry ||= k.startsWith("entry:")), set(k, ...rest));
    tx.delete = (k) => ((entry ||= k.startsWith("entry:")), del(k));
    tx.commit = async () => {
      const r = await commit();
      if (entry) stats[r.ok ? "committed" : "failed"]++;
      return r;
    };
    return tx;
  };
  return stats;
}

test("50 simultaneous entries do not contend on the giveaway record and all enter the draw", async () => {
  const { h } = setup();
  const id = await launch(h, 3);
  const stats = conflicts(h);
  const crowd = ids.slice(0, 50);
  const replies = await Promise.all(crowd.map((u) => enter(h, id, u)));
  expect(replies.map(reply)).toEqual(crowd.map(() => "Your entry is recorded."));
  expect(stats).toEqual({ failed: 0, committed: 50 });
  expect(h.scheduled.filter((s) => s.task === "refresh")).toHaveLength(1);
  await Promise.all(
    crowd
      .slice(0, 5)
      .map((u) => runComponent(plugin, h, "leave:" + id, { user: u, channel: "lobby" })),
  );
  expect(stats.failed).toBe(0);
  await plugin.tasks!.refresh!(h.ctx, h.scheduled.find((s) => s.task === "refresh")!.payload);
  expect(entrantsField(lastPanel(h))).toBe("45");
  expect((await callRoute(plugin, h, "GET /giveaways/" + id)).body).toMatchObject({ entrants: 45 });
  vi.setSystemTime(Date.now() + 3600 * 1000);
  await plugin.tasks!.finish!(h.ctx, { id });
  const g = record(h, id);
  expect(g).toMatchObject({ state: "ended", entrants: 45 });
  expect(h.kv.has("entrants:" + id)).toBe(false);
  const stored = crowd.slice(5).map((userId) => ({ userId, weight: 1 }));
  expect((await callRoute(plugin, h, "GET /giveaways/" + id)).body).toMatchObject({
    entrants: 45,
    entrantsHash: entrantsHash(stored.toSorted((a, b) => Number(a.userId) - Number(b.userId))),
  });
});

test("an entry committed while the draw reads the entrant list is refused, never left out of the draw", async () => {
  const { h } = setup();
  const id = await launch(h);
  await enter(h, id, "1001");
  // A manager ends the giveaway early; an entry lands while the draw lists the entrants.
  const list = h.ctx.kv.list.bind(h.ctx.kv);
  let late: Promise<unknown> | undefined;
  h.ctx.kv.list = (async (o: Parameters<typeof list>[0]) => {
    const page = await list(o);
    if (!late && o?.prefix === `entry:${id}:`) late = enter(h, id, "1002").then(reply);
    await late;
    return page;
  }) as typeof list;
  await runCommand(plugin, h, "giveaway end", { user: HOST, options: { id } });
  expect(await late).toBe("This giveaway is closed.");
  expect(h.kv.has(`entry:${id}:1002`)).toBe(false);
  expect(record(h, id)).toMatchObject({ state: "ended", entrants: 1, winners: ["1001"] });
});

test("a giveaway started by the previous version keeps its count; the public proof is paginated", async () => {
  const { h } = setup();
  const id = await launch(h, 1);
  // 0.1.0 counted entries in the record itself and had no counter.
  const legacy = { ...(h.kv.get("gw:" + id) as Record<string, Json>), entrants: 3 };
  await h.ctx.kv.set("gw:" + id, legacy);
  for (const u of ["1001", "1002", "1003"]) await h.ctx.kv.set(`entry:${id}:${u}`, 1);
  await enter(h, id, "1004");
  await plugin.tasks!.refresh!(h.ctx, { id });
  expect(entrantsField(lastPanel(h))).toBe("4");
  // 1,200 entrants: an anonymous request reads one page at a time.
  for (let i = 0; i < 1196; i++) await h.ctx.kv.set(`entry:${id}:${String(5000 + i)}`, 1);
  vi.setSystemTime(Date.now() + 3600 * 1000);
  await plugin.tasks!.finish!(h.ctx, { id });
  expect(record(h, id).entrants).toBe(1200);
  const list = h.ctx.kv.list.bind(h.ctx.kv);
  let reads = 0;
  h.ctx.kv.list = (o) => (reads++, list(o)) as never;
  const page1 = (await callRoute(plugin, h, "GET /giveaways/" + id)).body as {
    entries: { userId: string; weight: number }[];
    entriesCursor?: string;
    seed: string;
    winners: string[];
    entrantsHash: string;
  };
  expect(reads).toBe(1);
  expect(page1.entries).toHaveLength(1000);
  const page2 = (
    await callRoute(plugin, h, "GET /giveaways/" + id, { query: { cursor: page1.entriesCursor! } })
  ).body as typeof page1;
  expect(page2.entriesCursor).toBeUndefined();
  const all = [...page1.entries, ...page2.entries];
  expect(new Set(all.map((e) => e.userId)).size).toBe(1200);
  expect(verify({ seed: page1.seed, id, entries: all, count: 1 })).toMatchObject({
    entrantsHash: page1.entrantsHash,
    winners: page1.winners,
  });
});

test("the bundled verifier follows entriesCursor to the last page (2,500 entrants)", async () => {
  const { h } = setup();
  const id = await launch(h, 2);
  for (let i = 0; i < 2500; i++) await h.ctx.kv.set(`entry:${id}:${String(10000 + i)}`, 1 + (i % 3));
  vi.setSystemTime(Date.now() + 3600 * 1000);
  await plugin.tasks!.finish!(h.ctx, { id });
  // A fetch that serves the plugin's routes, as the portal API does.
  const requested: string[] = [];
  const serve = (viewer?: string) =>
    (async (url: URL) => {
      requested.push(url.pathname + url.search);
      const cursor = url.searchParams.get("cursor");
      const res = await callRoute(plugin, h, "GET " + url.pathname, {
        ...(cursor ? { query: { cursor } } : {}),
        ...(viewer ? { viewer } : {}),
      });
      return { ok: res.status === 200, status: res.status, json: async () => res.body };
    }) as unknown as typeof fetch;
  const draw = await fetchDraw("https://portal.test/giveaways/" + id, { fetch: serve() });
  expect(requested).toHaveLength(3);
  expect(draw.entries).toHaveLength(2500);
  const published = draw as unknown as { seed: string; entrantsHash: string; winners: string[] };
  expect(verify({ seed: published.seed, id, entries: draw.entries, count: 2 })).toMatchObject({
    entrantsHash: published.entrantsHash,
    winners: published.winners,
  });
  // Reading only the first page cannot reproduce the published proof.
  const firstPage = (await callRoute(plugin, h, "GET /giveaways/" + id)).body as {
    entries: { userId: string; weight: number }[];
  };
  expect(firstPage.entries).toHaveLength(1000);
  expect(
    verify({ seed: published.seed, id, entries: firstPage.entries, count: 2 }).entrantsHash,
  ).not.toBe(published.entrantsHash);
  // The moderator route pages the same way.
  requested.length = 0;
  const staff = await fetchDraw("https://portal.test/giveaways/" + id + "/entries", {
    fetch: serve(HOST),
  });
  expect(requested).toHaveLength(3);
  expect(staff.entries).toEqual(draw.entries);
});
