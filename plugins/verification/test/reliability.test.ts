import type { ImageSpec, Member } from "@cicord/sdk";
import { createTestContext, callRoute } from "@cicord/sdk/testing";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import en from "../locales/en.json" with { type: "json" };
import schema from "../config.schema.json" with { type: "json" };
import plugin from "../src/index.ts";

const HOUR = 3_600_000;
const snowflake = (created: number, n: bigint) =>
  (((BigInt(created) - 1420070400000n) << 22n) + n).toString();
let youngId: string, oldId: string;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-26T12:00:00Z"));
  youngId = snowflake(Date.now() - 86_400_000, 1n);
  oldId = snowflake(Date.now() - 400 * 86_400_000, 2n);
});
afterEach(() => vi.useRealTimers());

function harness(config: Record<string, unknown>, features: string[], extra = {}) {
  return createTestContext({
    schema,
    locales: { en },
    config: { method: "button", ...config },
    features,
    roles: { verified: { name: "Verified" } },
    channels: { verify: { name: "Verify" } },
    server: { ownerId: "99" },
    members: [
      { id: youngId, avatarUrl: "https://example.invalid/a.png", joinedAt: new Date() },
      { id: oldId, avatarUrl: "https://example.invalid/b.png", joinedAt: new Date() },
      { id: "99" },
    ],
    ...extra,
  });
}
type Harness = ReturnType<typeof harness>;
const statuses = (t: Harness) => {
  const seen = new Map<string, string | null>();
  vi.spyOn(t.ctx.status, "set").mockImplementation((key, message) => void seen.set(key, message));
  return seen;
};
/** Wrap a member so selected methods fail like Discord would (closed DMs, missing permission). */
function failing(t: Harness, id: string, methods: Partial<Record<keyof Member, Error>>) {
  const original = t.ctx.server.member.bind(t.ctx.server);
  vi.spyOn(t.ctx.server, "member").mockImplementation(async (ref) => {
    const m = await original(ref);
    if (!m || m.id !== id) return m;
    return new Proxy(m, {
      get(target, key, receiver) {
        const error = methods[key as keyof Member];
        if (error)
          return async () => {
            throw error;
          };
        const value = Reflect.get(target, key, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  });
}
async function solve(t: Harness, viewer: string) {
  const { id } = (await callRoute(plugin, t, "GET /challenge", { viewer })).body as { id: string };
  return (await callRoute(plugin, t, "POST /challenge", { viewer, body: { id } })).body;
}
const expiry = (t: Harness) => plugin.schedules!.expiry!.run(t.ctx);

test("a delayed member is not kicked before the retry time plus the expiry window", async () => {
  const t = harness({ youngAccount: "delay", delayHours: 24, kickAfterHours: 2 }, [
    "dm",
    "directKick",
  ]);
  expect(await solve(t, youngId)).toMatchObject({ state: "delay" });
  const record = t.kv.get("pending:" + youngId) as { deadline: number; retry: number };
  expect(record.deadline).toBe(record.retry + 2 * HOUR);
  vi.setSystemTime(Date.now() + 3 * HOUR);
  await expiry(t);
  vi.setSystemTime(record.retry + HOUR);
  await expiry(t);
  expect(t.moderation).toEqual([]);
  // A record stored before this fix kept the join-based deadline: it gets the same window.
  t.kv.set("pending:" + youngId, { ...record, deadline: record.retry - 20 * HOUR });
  await expiry(t);
  expect(t.moderation).toEqual([]);
  vi.setSystemTime(record.retry + 2 * HOUR + 1);
  await expiry(t);
  expect(t.moderation).toMatchObject([{ action: "kick", member: youngId, reason: "expired" }]);
});

test("closed DMs never block an expiry kick, and one failure does not stall the others", async () => {
  const t = harness({ minAccountAgeDays: 0, kickAfterHours: 1 }, ["dm", "directKick"]);
  const seen = statuses(t);
  await callRoute(plugin, t, "GET /challenge", { viewer: youngId });
  await callRoute(plugin, t, "GET /challenge", { viewer: oldId });
  vi.setSystemTime(Date.now() + 2 * HOUR);
  failing(t, youngId, { send: new Error("Cannot send messages to this user") });
  await expiry(t);
  expect(t.moderation.map((m) => m.member).sort()).toEqual([youngId, oldId].sort());
  expect(t.kv.get("expiryCursor")).toBeUndefined();

  const u = harness({ minAccountAgeDays: 0, kickAfterHours: 1 }, ["directKick"]);
  const failures = statuses(u);
  await callRoute(plugin, u, "GET /challenge", { viewer: youngId });
  await callRoute(plugin, u, "GET /challenge", { viewer: oldId });
  vi.setSystemTime(Date.now() + 2 * HOUR);
  failing(u, youngId, { kick: new Error("Missing Permissions") });
  await expect(expiry(u)).resolves.toBeUndefined();
  expect(u.moderation).toMatchObject([{ action: "kick", member: oldId }]);
  expect(failures.get("expiry")).toContain("1 expired pending members could not be kicked");
  expect(u.kv.get("pending:" + youngId)).toBeDefined();
  expect(seen.get("expiry")).toBeNull();
});

test("a missing sanction grant is named at start; young accounts are held, never stalled", async () => {
  const t = harness({ youngAccount: "kick", kickAfterHours: 1 }, ["dm"]);
  const seen = statuses(t);
  await plugin.onStart!(t.ctx);
  expect(seen.get("kick")).toContain("discord.members.moderate");
  expect(seen.get("kickNotice")).toBeNull();
  expect(await solve(t, youngId)).toMatchObject({ state: "hold" });
  expect((await callRoute(plugin, t, "GET /queue", { viewer: "99" })).body).toMatchObject({
    items: [{ userId: youngId }],
  });
  await callRoute(plugin, t, "GET /challenge", { viewer: oldId });
  vi.setSystemTime(Date.now() + 2 * HOUR);
  await expect(expiry(t)).resolves.toBeUndefined();
  expect(t.moderation).toEqual([]);

  const u = harness({ kickAfterHours: 1 }, ["directKick"]);
  const notice = statuses(u);
  await plugin.onStart!(u.ctx);
  expect(notice.get("kick")).toBeNull();
  expect(notice.get("kickNotice")).toContain("discord.dm.send");
});

test("the visual code is drawn from a CSPRNG among 12 similar choices; guessing ends in review", async () => {
  const drawn: ImageSpec[] = [];
  const t = harness({ method: "visual", minAccountAgeDays: 0 }, ["visual"], {
    renderImage: async (spec: ImageSpec) => {
      drawn.push(spec);
      return { data: new Uint8Array([1, 2, 3]), contentType: "image/png" as const };
    },
  });
  const get = async () =>
    (await callRoute(plugin, t, "GET /challenge", { viewer: oldId })).body as {
      id: string;
      method: string;
      choices: number[];
      prompt: string;
      image: string;
    };
  const first = await get();
  expect(first).toMatchObject({ method: "visual", prompt: "Which number is shown in the image?" });
  expect(first.image.startsWith("data:image/png;base64,")).toBe(true);
  expect(new Set(first.choices).size).toBe(12);
  const code = Number(
    drawn[0]!.layers!.flatMap((l) => (l.type === "text" ? [l.text] : [])).join(""),
  );
  expect(code).toBeGreaterThanOrEqual(1000);
  expect(first.choices).toContain(code);
  expect(t.kv.get("challenge:" + oldId)).toMatchObject({ answer: code });
  const wrong = (c: { id: string; choices: number[] }, answer: number) =>
    callRoute(plugin, t, "POST /challenge", {
      viewer: oldId,
      body: { id: c.id, answer: c.choices.find((n) => n !== answer)! },
    });
  // Three failures lock the challenge for 15 minutes.
  for (let i = 0; i < 3; i++) {
    const c = i ? await get() : first;
    const answer = (t.kv.get("challenge:" + oldId) as { answer: number }).answer;
    expect((await wrong(c, answer)).status).toBe(422);
  }
  const locked = await get();
  expect(
    (
      await callRoute(plugin, t, "POST /challenge", {
        viewer: oldId,
        body: {
          id: locked.id,
          answer: (t.kv.get("challenge:" + oldId) as { answer: number }).answer,
        },
      })
    ).status,
  ).toBe(429);
  // Three more within the day send the member to staff review.
  vi.setSystemTime(Date.now() + 16 * 60_000);
  let last;
  for (let i = 0; i < 3; i++) {
    const c = await get();
    last = await wrong(c, (t.kv.get("challenge:" + oldId) as { answer: number }).answer);
  }
  expect(last!.body).toMatchObject({ state: "hold" });
  expect(t.roleChanges).toEqual([]);
  expect(t.published.filter((e) => e.topic === "failed").at(-1)?.payload).toMatchObject({
    reason: "attempts",
  });
  expect(await plugin.privacy!.export(t.ctx, oldId)).toHaveProperty("strikes", 6);
  await plugin.privacy!.erase(t.ctx, oldId);
  expect(await plugin.privacy!.export(t.ctx, oldId)).toEqual({});
});

test("a correct visual answer verifies once", async () => {
  const t = harness({ method: "visual", minAccountAgeDays: 0 }, ["visual"], {
    renderImage: async () => ({ data: new Uint8Array([1]), contentType: "image/png" as const }),
  });
  const { id } = (await callRoute(plugin, t, "GET /challenge", { viewer: oldId })).body as {
    id: string;
  };
  const answer = (t.kv.get("challenge:" + oldId) as { answer: number }).answer;
  const post = () =>
    callRoute(plugin, t, "POST /challenge", { viewer: oldId, body: { id, answer } });
  expect((await post()).body).toEqual({ verified: true });
  expect((await post()).status).toBe(409);
  expect(t.roleChanges).toHaveLength(1);
});

test("a crash after the role grant is completed by the delivery task with one stable event", async () => {
  const t = harness({ minAccountAgeDays: 0 }, []);
  const publish = t.ctx.events.publish.bind(t.ctx.events);
  const keys: (string | undefined)[] = [];
  let crash = true;
  vi.spyOn(t.ctx.events, "publish").mockImplementation(async (topic, payload, options) => {
    keys.push(options?.idempotencyKey);
    if (crash) {
      crash = false;
      throw new Error("runtime stopped");
    }
    return publish(topic, payload, options);
  });
  await expect(solve(t, oldId)).rejects.toThrow("runtime stopped");
  expect(t.roleChanges).toHaveLength(1);
  expect(t.kv.get("outbox:" + oldId)).toBeDefined();
  await plugin.schedules!.delivery!.run(t.ctx);
  await plugin.schedules!.delivery!.run(t.ctx);
  expect(t.published.filter((e) => e.topic === "passed")).toHaveLength(1);
  expect(new Set(keys).size).toBe(1);
  expect(t.kv.get("outbox:" + oldId)).toBeUndefined();

  // A crash between the role grant record and the role itself: delivery grants and publishes.
  const u = harness({ minAccountAgeDays: 0 }, []);
  const joined = u.member(youngId)!.joinedAt.getTime();
  u.kv.set("grant:" + youngId, {
    joined,
    role: "verified",
    result: { result: "passed", method: "button", at: new Date().toISOString() },
  });
  await plugin.schedules!.delivery!.run(u.ctx);
  await plugin.schedules!.delivery!.run(u.ctx);
  expect(u.roleChanges).toMatchObject([{ member: youngId, action: "add" }]);
  expect(u.published.filter((e) => e.topic === "passed")).toHaveLength(1);
});

test("typed is the default: a CSPRNG code of the unambiguous alphabet, kept server-side", async () => {
  expect((schema as { properties: { method: { default: string } } }).properties.method.default).toBe(
    "typed",
  );
  const drawn: ImageSpec[] = [];
  const t = harness({ method: "typed", minAccountAgeDays: 0 }, ["visual"], {
    renderImage: async (spec: ImageSpec) => {
      drawn.push(spec);
      return { data: new Uint8Array([1, 2, 3]), contentType: "image/png" as const };
    },
  });
  const get = async () =>
    (await callRoute(plugin, t, "GET /challenge", { viewer: oldId })).body as Record<
      string,
      unknown
    > & { id: string };
  const c = await get();
  expect(c).toMatchObject({
    method: "typed",
    kind: "typed",
    length: 6,
    charset: "alphanumeric",
    prompt: "Type the code shown in the image.",
  });
  expect(String(c.image)).toMatch(/^data:image\/png;base64,/);
  const spec = drawn[0]!;
  expect(spec.width! <= 2048 && spec.height! <= 2048 && spec.width! * spec.height! <= 524288).toBe(
    true,
  );
  const code = (t.kv.get("challenge:" + oldId) as { code: string }).code;
  expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
  expect(spec.layers!.flatMap((l) => (l.type === "text" ? [l.text] : [])).join("")).toBe(code);
  // Neither the code nor a hint of it leaves the plugin.
  expect(JSON.stringify(c)).not.toContain(code);
  expect(c).not.toHaveProperty("choices");
  const post = (id: string, answer: unknown) =>
    callRoute(plugin, t, "POST /challenge", { viewer: oldId, body: { id, answer } as never });
  // Wrong type, length or alphabet fail, and each attempt consumes the challenge.
  expect((await post(c.id, 123456)).status).toBe(422);
  const c2 = await get();
  const code2 = (t.kv.get("challenge:" + oldId) as { code: string }).code;
  expect((await post(c2.id, code2 + "A")).status).toBe(422);
  expect(t.kv.has("challenge:" + oldId)).toBe(false);
  vi.setSystemTime(Date.now() + 16 * 60_000);
  const c3 = await get();
  const code3 = (t.kv.get("challenge:" + oldId) as { code: string }).code;
  expect((await post(c3.id, code3.slice(0, 5) + "0")).status).toBe(422);
  // Case-insensitive: the lower-cased code verifies.
  const c4 = await get();
  const code4 = (t.kv.get("challenge:" + oldId) as { code: string }).code;
  expect((await post(c4.id, " " + code4.toLowerCase() + " ")).body).toEqual({ verified: true });
  // The codes differ between challenges.
  expect(new Set([code, code2, code3, code4]).size).toBeGreaterThan(1);
});

test("typed without the render grant never passes silently: staff review or the configured button", async () => {
  const t = harness({ method: "typed", minAccountAgeDays: 0 }, []);
  const seen = statuses(t);
  await plugin.onStart!(t.ctx);
  expect(seen.get("challenge")).toContain("render");
  const r = await callRoute(plugin, t, "GET /challenge", { viewer: oldId });
  expect(r.body).toMatchObject({ state: "hold" });
  expect(t.roleChanges).toEqual([]);
  expect(t.published.at(-1)).toMatchObject({ topic: "failed", payload: { reason: "unavailable" } });
  const b = harness({ method: "typed", fallback: "button", minAccountAgeDays: 0 }, []);
  const seenB = statuses(b);
  await plugin.onStart!(b.ctx);
  expect(seenB.get("challenge")).toBeTruthy();
  const c = (await callRoute(plugin, b, "GET /challenge", { viewer: oldId })).body as {
    id: string;
    method: string;
  };
  expect(c.method).toBe("button");
});

test("a render failure sets a status line and degrades to review, or to the button when configured", async () => {
  const broken = { renderImage: async () => Promise.reject(new Error("renderer crashed")) };
  const t = harness({ method: "typed", minAccountAgeDays: 0 }, ["visual"], broken);
  const seen = statuses(t);
  expect((await callRoute(plugin, t, "GET /challenge", { viewer: oldId })).body).toMatchObject({
    state: "hold",
  });
  expect(seen.get("render")).toContain("could not be rendered");
  expect(t.roleChanges).toEqual([]);
  const b = harness({ method: "typed", fallback: "button", minAccountAgeDays: 0 }, ["visual"], broken);
  statuses(b);
  const c = (await callRoute(plugin, b, "GET /challenge", { viewer: oldId })).body as {
    id: string;
    method: string;
  };
  expect(c.method).toBe("button");
  expect(
    (await callRoute(plugin, b, "POST /challenge", { viewer: oldId, body: { id: c.id } })).body,
  ).toEqual({ verified: true });
});
