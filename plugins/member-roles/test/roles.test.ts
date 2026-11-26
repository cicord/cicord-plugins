import { afterEach, expect, it, vi } from "vite-plus/test";
import { InteropError, type Context, type Member, type Role } from "@cicord/sdk";
import plugin from "../src/index.ts";
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
    announcements: string[] = [],
    status = new Map<string, string | null>(),
    published: { topic: string; payload: unknown }[] = [];
  const roles = new Map<string, Role>();
  let next = 100;
  const makeRole = (
    name: string,
    position: number,
    declaredMembers = false,
    managed = false,
    permissions: string | null = "0",
  ) => {
    const role = {
      id: String(++next),
      name,
      key: name,
      position,
      managed,
      declaredMembers,
      ...(permissions === null ? {} : { permissions }),
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
      temp: {
        roles: [] as string[],
        managerRoles: ["mod"],
        maxDays: 90,
        privilegedRoles: [] as string[],
      },
    },
    bot: { user: { id: "999" } },
    i18n: { t: (key: string) => key },
    log: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
    status: { set: (k: string, v: string | null) => status.set(k, v) },
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
      publish: async (topic: string, payload: unknown, opts: { idempotencyKey: string }) => {
        if (!events.has(opts.idempotencyKey)) published.push({ topic, payload });
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
    status,
    published,
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
    await expect(validateRoles(f.ctx)).resolves.toEqual(["declared"]);
    expect(f.status.get("role:declared")).toBe("status.unmanaged");
  }
  await expect(
    grant(f.ctx, { userId: member.id, role: "declared", durationSeconds: 1 }, "one"),
  ).rejects.toThrow("error.unmanaged");
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
  await scan(f.ctx, true);
  await scan(f.ctx, true);
  expect(f.data.get("scan")).toMatchObject({ done: true });
  expect(f.calls.filter((k) => k.endsWith("/regular"))).toHaveLength(51);
  const a = await grant(f.ctx, { userId: "10", role: "visitor", durationSeconds: 100 }, "first");
  await grant(f.ctx, { userId: "11", role: "visitor", durationSeconds: 100 }, "second");
  await leave(f.ctx, "10", f.member("10", [f.sticky]));
  await subjectData(f.ctx, "10", true);
  // The live grant is retained, without its request token, until it expires.
  expect((await subjectData(f.ctx, "10", false)).result).toEqual({
    ["temporary:10:" + a.roleId]: expect.objectContaining({ request: "", expiresAt: a.expiresAt }),
  });
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
  for (let n = 0; n < 20; n++) await scan(first, n > 0);
  expect(f.data.get("scan")).toMatchObject({ after: "500", done: false });
  const resumed = restart();
  // A restart starts no second chain while the first one's lease is alive.
  await scan(resumed);
  expect(calls).toBe(20);
  for (let n = 20; n <= 2000; n++) await scan(resumed, true);
  expect(visited.size).toBe(50000);
  expect(calls).toBe(2001);
  expect(f.data.get("scan")).toMatchObject({ done: true });
});

it("a refused role never stops startup, member events or the scan, and other roles still apply", async () => {
  const f = fixture();
  f.makeRole("declared", 1, true);
  f.makeRole("above", 60);
  f.config.sticky.roles = ["declared"];
  f.config.tenure = [
    { days: 1, role: "above" },
    { days: 1, role: "regular" },
  ];
  f.config.boost.role = "missing-role";
  const context = f.ctx as unknown as { server: { role: (r: unknown) => Role } };
  const role = context.server.role;
  context.server.role = (r) => {
    if (r === "missing-role") throw new Error("unknown role");
    return role(r);
  };
  await expect(plugin.onStart!(f.ctx)).resolves.toBeUndefined();
  expect(f.status.get("role:declared")).toBe("status.unmanaged");
  expect(f.status.get("role:above")).toBe("status.hierarchy");
  expect(f.status.get("role:missing-role")).toBe("status.missing");
  expect(f.status.get("role:regular")).toBeNull();
  for (let i = 10; i < 14; i++) f.member(String(i));
  await expect(scan(f.ctx)).resolves.toBeUndefined();
  const m = f.member("20", [], new Date(0), new Date(1700000000000));
  await expect(joined(f.ctx, m)).resolves.toBeUndefined();
  expect(m.roles.map((r) => r.key)).toEqual(["regular"]);
  expect(f.calls.some((c) => c.endsWith("/above") || c.endsWith("/declared"))).toBe(false);
});

it("inter-plugin grants need an explicit allowlist and the represented member's authority", async () => {
  const f = fixture();
  const target = f.member("21");
  const call = (onBehalfOf?: { userId: string; access: "member" | "moderator" | "scoped" }) => ({
    caller: { plugin: "shop", bot: "main", instance: "shop", source: "plugin", verified: true },
    idempotencyKey: "k:" + (onBehalfOf?.userId ?? "none"),
    ...(onBehalfOf ? { onBehalfOf } : {}),
  });
  const input = { userId: target.id, role: "visitor", durationSeconds: 60 };
  const run = (c: ReturnType<typeof call>) =>
    plugin.actions!.grantTemporary!.run(f.ctx, input as never, c as never);
  // Empty temp.roles is "every assignable role" for /temprole, never for other plugins.
  await expect(run(call())).rejects.toBeInstanceOf(InteropError);
  await expect(run(call())).rejects.toMatchObject({ code: "denied" });
  await expect(
    plugin.actions!.revoke!.run(f.ctx, { userId: "21", role: "visitor" } as never, call() as never),
  ).rejects.toMatchObject({ code: "denied" });
  f.config.temp.roles = ["visitor", "mod"];
  await expect(
    plugin.actions!.grantTemporary!.run(
      f.ctx,
      { ...input, role: "regular" } as never,
      call() as never,
    ),
  ).rejects.toMatchObject({ code: "denied" });
  f.member("30");
  await expect(run(call({ userId: "30", access: "member" }))).rejects.toMatchObject({
    code: "denied",
  });
  // A member's own purchase or claim needs no manager authority, only the allowlist.
  await expect(
    plugin.actions!.grantTemporary!.run(
      f.ctx,
      { ...input, userId: "30" } as never,
      call({ userId: "30", access: "member" }) as never,
    ),
  ).resolves.toMatchObject({ userId: "30" });
  await expect(
    plugin.actions!.grantTemporary!.run(
      f.ctx,
      { ...input, userId: "30", role: "regular" } as never,
      call({ userId: "30", access: "member" }) as never,
    ),
  ).rejects.toMatchObject({ code: "denied" });
  await expect(run(call({ userId: "31", access: "scoped" }))).rejects.toMatchObject({
    code: "denied",
  });
  // A manager below the role cannot grant it through another plugin either.
  f.member("32", [f.makeRole("junior", 1)]);
  f.config.temp.managerRoles = ["junior"];
  await expect(run(call({ userId: "32", access: "moderator" }))).rejects.toMatchObject({
    code: "denied",
  });
  f.config.temp.managerRoles = ["mod"];
  f.member("33", [f.mod]);
  await expect(
    plugin.actions!.grantTemporary!.run(
      f.ctx,
      { ...input, durationSeconds: 0 } as never,
      call({ userId: "33", access: "moderator" }) as never,
    ),
  ).rejects.toMatchObject({ code: "invalid_input" });
  await expect(run(call({ userId: "33", access: "moderator" }))).resolves.toMatchObject({
    userId: "21",
  });
  await expect(run(call())).resolves.toMatchObject({ userId: "21" });
  expect(target.hasRole("visitor")).toBe(true);
});

it("erasure keeps a live grant until it expires, then the role is removed and the expiry published", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01"));
  const f = fixture();
  const m = f.member("21");
  const g = await grant(f.ctx, { userId: m.id, role: "visitor", durationSeconds: 60 }, "one");
  await leave(f.ctx, "21", f.member("21", [f.sticky, f.visitor]));
  const result = await subjectData(f.ctx, "21", true);
  expect(result.erased).toBe(2);
  expect(f.data.has("sticky:21")).toBe(false);
  expect([...f.jobs.values()].filter((j) => j.task === "expire")).toHaveLength(1);
  const current = f.members.get("21")!;
  vi.setSystemTime(g.expiresAt);
  await expire(f.ctx, g);
  expect(current.hasRole("visitor")).toBe(false);
  expect(f.data.has("temporary:21:" + g.roleId)).toBe(false);
  expect(f.published).toEqual([
    { topic: "tempRoleExpired", payload: { userId: "21", roleId: g.roleId, expiresAt: g.expiresAt } },
  ]);
});

it("publishes tempRoleExpired even when the member no longer holds the role", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01"));
  const f = fixture();
  const m = f.member("21");
  const g = await grant(f.ctx, { userId: m.id, role: "visitor", durationSeconds: 60 }, "one");
  // For example a moderation quarantine removed it and saved it for restoration.
  await m.removeRole(f.visitor);
  vi.setSystemTime(g.expiresAt);
  await expire(f.ctx, g);
  expect(f.calls).toEqual(["+21/visitor", "-21/visitor"]);
  expect(f.published).toEqual([
    { topic: "tempRoleExpired", payload: { userId: "21", roleId: g.roleId, expiresAt: g.expiresAt } },
  ]);
});

it("cron ticks during an unfinished scan do not start parallel page chains", async () => {
  const f = fixture();
  f.config.tenure = [{ days: 1, role: "regular" }];
  for (let i = 10; i < 61; i++) f.member(String(i));
  await scan(f.ctx);
  const chained = () => [...f.jobs.values()].filter((j) => j.task === "scan").length;
  expect(chained()).toBe(1);
  await scan(f.ctx);
  await scan(f.ctx);
  expect(chained()).toBe(1);
  expect(f.data.get("scan")).toMatchObject({ after: "34" });
  await scan(f.ctx, true);
  await scan(f.ctx, true);
  expect(f.data.get("scan")).toMatchObject({ done: true });
  expect(f.data.has("scan:next")).toBe(false);
});

it("privileged or unknown-permission roles are never granted temporarily unless opted in (MOD-09)", async () => {
  const f = fixture();
  f.member("40");
  const bit = (n: number) => (1n << BigInt(n)).toString();
  // Below the bot, assignable: only their permissions make them dangerous.
  f.makeRole("admin", 10, false, false, bit(3));
  f.makeRole("banner", 9, false, false, (1n << 2n | 1n << 10n).toString());
  f.makeRole("timeouts", 8, false, false, bit(40));
  f.makeRole("unknown", 7, false, false, null);
  f.makeRole("chatty", 6, false, false, (1n << 10n | 1n << 11n).toString()); // View, Send
  f.config.temp.roles = ["admin", "banner", "timeouts", "unknown", "chatty"];
  const call = {
    caller: { plugin: "shop", bot: "main", instance: "shop", source: "plugin", verified: true },
    idempotencyKey: "k",
  };
  const ask = (role: string, key = role) =>
    plugin.actions!.grantTemporary!.run(
      f.ctx,
      { userId: "40", role, durationSeconds: 60 } as never,
      { ...call, idempotencyKey: key } as never,
    );
  for (const role of ["admin", "banner", "timeouts", "unknown"])
    await expect(ask(role)).rejects.toMatchObject({ code: "denied" });
  await expect(ask("admin")).rejects.toThrow("error.privileged");
  await expect(ask("unknown")).rejects.toThrow("error.permissionsUnknown");
  await expect(ask("chatty")).resolves.toMatchObject({ userId: "40" });
  // /temprole with an empty allowlist refuses them too.
  f.config.temp.roles = [];
  await expect(
    grant(f.ctx, { userId: "40", role: "banner", durationSeconds: 60 }, "i:1", f.member("42")),
  ).rejects.toThrow("error.privileged");
  // The startup check names the listed privileged roles.
  f.config.temp.roles = ["admin", "chatty"];
  await validateRoles(f.ctx);
  expect(f.status.get("privileged:admin")).toBe("status.privileged");
  expect(f.status.get("privileged:chatty")).toBeNull();
  // An explicit opt-in allows it and clears the line.
  f.config.temp.privilegedRoles = ["admin"];
  await expect(ask("admin", "k2")).resolves.toMatchObject({ userId: "40" });
  await validateRoles(f.ctx);
  expect(f.status.get("privileged:admin")).toBeNull();
  expect(f.calls).toEqual(["+40/chatty", "+40/admin"]);
});
