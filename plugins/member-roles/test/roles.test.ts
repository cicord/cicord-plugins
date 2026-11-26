import { afterEach, expect, it, vi } from "vite-plus/test";
import type { Context, Member, Role } from "@cicord/sdk";
import {
  changed,
  expire,
  grant,
  joined,
  leave,
  manager,
  revoke,
  scan,
  subjectData,
  validateRoles,
} from "../src/roles.ts";

function fixture() {
  const data = new Map<string, unknown>(),
    jobs = new Map<string, { task: string; payload: unknown }>(),
    events = new Set<string>(),
    calls: string[] = [],
    announcements: string[] = [];
  const roles = new Map<string, Role>();
  let next = 100;
  const makeRole = (name: string, position: number, declaredMembers = false, managed = false) => {
    const role = {
      id: String(++next),
      name,
      key: name,
      position,
      managed,
      declaredMembers,
    } as Role;
    roles.set(name, role);
    roles.set(role.id, role);
    return role;
  };
  const reference = (r: string | { id: string }) => roles.get(typeof r === "string" ? r : r.id)!;
  const botRole = makeRole("bot", 50),
    visitor = makeRole("visitor", 3),
    mod = makeRole("mod", 20),
    sticky = makeRole("sticky", 4),
    regular = makeRole("regular", 2),
    boost = makeRole("boost", 1);
  const members = new Map<string, Member>();
  function member(id: string, initial: Role[] = [], joinedAt = new Date(0), premiumSince?: Date) {
    const owned = new Map(initial.map((r) => [r.id, r]));
    const m = {
      id,
      user: { id, bot: id === "999" },
      joinedAt,
      premiumSince,
      permissions: id === "999" ? ["ManageRoles"] : [],
      get roles() {
        return [...owned.values()];
      },
      hasRole: (ref: string | { id: string }) => owned.has(reference(ref).id),
      addRole: async (ref: string | { id: string }) => {
        const r = reference(ref);
        calls.push("+" + id + "/" + r.key);
        owned.set(r.id, r);
      },
      removeRole: async (ref: string | { id: string }) => {
        const r = reference(ref);
        calls.push("-" + id + "/" + r.key);
        owned.delete(r.id);
      },
    } as unknown as Member;
    members.set(id, m);
    return m;
  }
  member("999", [botRole]);
  let jobSeq = 0;
  const context = {
    config: {
      enabled: true,
      sticky: { roles: ["sticky"], retentionDays: 90 },
      tenure: [] as { role: string; days: number }[],
      boost: {} as { role?: string; announce?: string },
      temp: { roles: [] as string[], managerRoles: ["mod"], maxDays: 90 },
    },
    bot: { user: { id: "999" } },
    i18n: { t: (key: string) => key },
    features: { enabled: () => true, report: vi.fn() },
    server: {
      id: "1",
      ownerId: "42",
      member: async (id: string) => members.get(id),
      role: reference,
      channel: () => ({ send: async (m: { content: string }) => announcements.push(m.content) }),
      members: async ({ after, limit }: { after?: string; limit: number }) =>
        [...members.values()]
          .filter((m) => !after || Number(m.id) > Number(after))
          .sort((a, b) => Number(a.id) - Number(b.id))
          .slice(0, limit),
    },
    kv: {
      get: async (k: string) => data.get(k),
      set: async (k: string, v: unknown) => {
        data.set(k, v);
      },
      delete: async (k: string) => {
        data.delete(k);
      },
      list: async ({ prefix }: { prefix: string }) => ({
        items: [...data]
          .filter(([key]) => key.startsWith(prefix))
          .map(([key, value]) => ({ key, value })),
      }),
    },
    schedule: {
      after: async (_ms: number, task: string, payload: unknown) => {
        const id = String(++jobSeq);
        jobs.set(id, { task, payload });
        return { id };
      },
      cancel: async (id: string) => {
        jobs.delete(id);
      },
    },
    events: {
      publish: async (_topic: string, _payload: unknown, opts: { idempotencyKey: string }) => {
        events.add(opts.idempotencyKey);
      },
    },
  };
  const ctx = context as unknown as Context;
  return {
    ctx,
    config: context.config,
    data,
    jobs,
    events,
    calls,
    roles,
    member,
    makeRole,
    visitor,
    mod,
    regular,
    sticky,
    boost,
    members,
    announcements,
  };
}
afterEach(() => vi.useRealTimers());

it("replays a grant, extends on a different key and ignores the stale expiry after a restart", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01"));
  const f = fixture(),
    m = f.member("21");
  const input = { userId: m.id, role: "visitor", durationSeconds: 120 };
  const [a, b] = await Promise.all([grant(f.ctx, input, "one"), grant(f.ctx, input, "one")]);
  expect(a).toEqual(b);
  expect(f.jobs.size).toBe(1);
  const extended = await grant(f.ctx, input, "two");
  expect(extended.expiresAt).toBe(a.expiresAt + 120000);
  vi.setSystemTime(a.expiresAt);
  await expire(f.ctx, a);
  expect(m.hasRole("visitor")).toBe(true);
  vi.setSystemTime(extended.expiresAt + 5000);
  await expire(f.ctx, extended);
  await expire(f.ctx, extended);
  expect(m.hasRole("visitor")).toBe(false);
  expect(f.calls).toEqual(["+21/visitor", "-21/visitor"]);
  expect(f.events.size).toBe(1);
});
it("restores sticky roles after departure and reconciles tenure and boost changes", async () => {
  const f = fixture();
  f.config.tenure.push({ days: 30, role: "regular" });
  f.config.boost.role = "boost";
  f.config.boost.announce = "news";
  await leave(f.ctx, "21", f.member("21", [f.sticky]));
  const m = f.member("21", [], new Date(0), new Date(1700000000000));
  await joined(f.ctx, m);
  await changed(f.ctx, m);
  expect(m.roles.map((r) => r.key).sort()).toEqual(["boost", "regular", "sticky"]);
  expect(f.announcements).toHaveLength(1);
  const ended = f.member("21", [...m.roles]);
  await changed(f.ctx, ended);
  expect(ended.hasRole("boost")).toBe(false);
});
it("rejects declarative roles, hierarchy violations, excessive duration and unauthorized managers", async () => {
  const f = fixture();
  const member = f.member("21");
  f.makeRole("declared", 1, true);
  for (const group of ["sticky", "tenure", "temp"]) {
    f.config.sticky.roles = group === "sticky" ? ["declared"] : [];
    f.config.tenure = group === "tenure" ? [{ days: 1, role: "declared" }] : [];
    f.config.temp.roles = group === "temp" ? ["declared"] : [];
    await expect(validateRoles(f.ctx)).rejects.toThrow("error.unmanaged");
  }
  f.config.temp.roles = [];
  f.makeRole("higher", 51);
  await expect(
    grant(f.ctx, { userId: member.id, role: "higher", durationSeconds: 1 }, "one"),
  ).rejects.toThrow("error.hierarchy");
  await expect(
    grant(f.ctx, { userId: member.id, role: "visitor", durationSeconds: 91 * 86400 }, "one"),
  ).rejects.toThrow("error.duration");
  await expect(manager(f.ctx, member)).rejects.toThrow("error.denied");
  await expect(manager(f.ctx, f.member("22", [f.mod]))).resolves.toBeUndefined();
});
it("resumes bounded tenure pages and erases only one member's jobs and records", async () => {
  const f = fixture();
  f.config.tenure = [{ days: 1, role: "regular" }];
  for (let i = 10; i < 61; i++) f.member(String(i));
  await scan(f.ctx);
  expect(f.data.get("scan")).toMatchObject({ after: "34", done: false });
  await scan(f.ctx);
  await scan(f.ctx);
  expect(f.data.get("scan")).toMatchObject({ done: true });
  expect(f.calls.filter((k) => k.endsWith("/regular"))).toHaveLength(51);
  const a = await grant(f.ctx, { userId: "10", role: "visitor", durationSeconds: 100 }, "first");
  await grant(f.ctx, { userId: "11", role: "visitor", durationSeconds: 100 }, "second");
  await leave(f.ctx, "10", f.member("10", [f.sticky]));
  await subjectData(f.ctx, "10", true);
  expect((await subjectData(f.ctx, "10", false)).result).toEqual({});
  expect((await subjectData(f.ctx, "11", false)).result).toHaveProperty("temporary:11:" + a.roleId);
  await expect(revoke(f.ctx, { userId: "11", role: "visitor" })).resolves.toEqual({
    revoked: true,
  });
});

it("checkpoints a 50,000-member scan and resumes after interruption", async () => {
  const f = fixture();
  f.config.sticky.roles = [];
  f.config.tenure = [{ days: 30, role: "regular" }];
  const visited = new Set<string>();
  let calls = 0;
  const today = new Date();
  const page = async (opts: { limit?: number; after?: string } = {}) => {
    calls++;
    expect(opts.limit).toBeLessThanOrEqual(1000);
    const out: Member[] = [];
    const from = Number(opts.after ?? 0) + 1;
    for (let n = from; n < from + (opts.limit ?? 100) && n <= 50000; n++) {
      const id = String(n);
      if (visited.has(id)) throw new Error("cursor repeated");
      visited.add(id);
      out.push({ id, user: { id, bot: false }, joinedAt: today, roles: [] } as unknown as Member);
    }
    return out;
  };
  const restart = () => ({ ...f.ctx, server: { ...f.ctx.server, members: page } }) as Context;
  const first = restart();
  for (let n = 0; n < 20; n++) await scan(first);
  expect(f.data.get("scan")).toMatchObject({ after: "500", done: false });
  const resumed = restart();
  for (let n = 20; n <= 2000; n++) await scan(resumed);
  expect(visited.size).toBe(50000);
  expect(calls).toBe(2001);
  expect(f.data.get("scan")).toMatchObject({ done: true });
});
