import type { Context, Member, Role, Json } from "@cicord/sdk";
import type { Grant, Revoke } from "./contracts.ts";

const DAY = 86_400_000;
const BATCH = 25;
type ActiveGrant = {
  userId: string;
  roleId: string;
  expiresAt: number;
  request: string;
  job: string;
};
const grantKey = (userId: string, roleId: string) => `temporary:${userId}:${roleId}`;
const stickyKey = (id: string) => "sticky:" + id;
const boostKey = (id: string) => "boost:" + id;

// Serialize conflicting external writes while this instance is live. Scheduled tasks
// also compare their durable expiration against the current grant after a restart.
const locks = new Map<string, Promise<unknown>>();
function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(fn);
  locks.set(key, next);
  return next.finally(() => {
    if (locks.get(key) === next) locks.delete(key);
  });
}
function translate(ctx: Context, key: string, vars: Record<string, string | number> = {}) {
  return ctx.i18n.t(key, vars);
}
function roleRef(ref: string) {
  return /^\d+$/.test(ref) ? { id: ref } : ref;
}
function resolve(ctx: Context, ref: string): Role {
  return ctx.server.role(roleRef(ref));
}
function assignable(ctx: Context, role: Role) {
  if (
    role.id === ctx.server.id ||
    role.managed !== false ||
    role.declaredMembers !== false ||
    role.position === undefined
  )
    throw new Error(translate(ctx, "error.unmanaged", { role: role.key ?? role.id }));
}
function outranks(actor: Member, role: Role) {
  return actor.roles.some(
    (r) =>
      r.position !== undefined &&
      role.position !== undefined &&
      (r.position > role.position ||
        (r.position === role.position &&
          r.id !== role.id &&
          /^\d+$/.test(r.id) &&
          /^\d+$/.test(role.id) &&
          BigInt(r.id) < BigInt(role.id))),
  );
}
async function checkRole(ctx: Context, role: Role, actor?: Member, cachedBot?: Member) {
  assignable(ctx, role);
  const bot = cachedBot ?? (await ctx.server.member(ctx.bot.user.id));
  if (!bot || !bot.permissions?.includes("ManageRoles") || !outranks(bot, role))
    throw new Error(translate(ctx, "error.hierarchy", { role: role.name }));
  if (actor && actor.id !== ctx.server.ownerId && !outranks(actor, role))
    throw new Error(translate(ctx, "error.hierarchy", { role: role.name }));
}
export async function manager(ctx: Context, actor?: Member) {
  if (!ctx.config.enabled || !actor) throw new Error(translate(ctx, "error.disabled"));
  if (actor.id === ctx.server.ownerId) return;
  const allowed = ctx.config.temp.managerRoles;
  if (
    allowed.length
      ? !allowed.some((ref) => actor.hasRole(roleRef(ref)))
      : !actor.permissions?.includes("ManageRoles")
  )
    throw new Error(translate(ctx, "error.denied"));
}
function temporaryRole(ctx: Context, ref: string) {
  if (!ctx.config.enabled) throw new Error(translate(ctx, "error.disabled"));
  const r = resolve(ctx, ref);
  if (
    ctx.config.temp.roles.length &&
    !ctx.config.temp.roles.some((key) => resolve(ctx, key).id === r.id)
  )
    throw new Error(translate(ctx, "error.denied"));
  return r;
}
async function ensure(
  ctx: Context,
  member: Member,
  role: Role,
  present: boolean,
  reason?: string,
  bot?: Member,
) {
  if (member.hasRole({ id: role.id }) === present) return;
  await checkRole(ctx, role, undefined, bot);
  if (present) await member.addRole({ id: role.id }, reason);
  else await member.removeRole({ id: role.id }, reason);
}
// Store an opaque equality token for the most recent request. Core owns the durable
// 30-day idempotency record. Caller-supplied keys can contain private workflow IDs.
function requestToken(value: string): string {
  let a = 0xcbf29ce484222325n,
    b = 0x84222325cbf29ce4n;
  for (const ch of value) {
    const n = BigInt(ch.codePointAt(0)!);
    a = BigInt.asUintN(64, (a ^ n) * 0x100000001b3n);
    b = BigInt.asUintN(64, (b + n) * 0x100000001b3n);
  }
  return a.toString(16).padStart(16, "0") + b.toString(16).padStart(16, "0");
}
export async function grant(ctx: Context, input: Grant, key: string, actor?: Member) {
  const role = temporaryRole(ctx, input.role);
  if (
    !Number.isSafeInteger(input.durationSeconds) ||
    input.durationSeconds < 1 ||
    input.durationSeconds > ctx.config.temp.maxDays * 86400
  )
    throw new Error(translate(ctx, "error.duration", { days: ctx.config.temp.maxDays }));
  return serial(grantKey(input.userId, role.id), async () => {
    await checkRole(ctx, role, actor);
    const member = await ctx.server.member(input.userId);
    if (!member) throw new Error(translate(ctx, "error.member"));
    const k = grantKey(input.userId, role.id);
    const old = await ctx.kv.get<ActiveGrant>(k);
    const request = requestToken(key);
    const expiresAt =
      old?.request === request
        ? old.expiresAt
        : Math.min(
            Date.now() + ctx.config.temp.maxDays * DAY,
            Math.max(Date.now(), old?.expiresAt ?? 0) + input.durationSeconds * 1000,
          );
    if (old?.request !== request) {
      const job = await ctx.schedule.after(Math.max(1, expiresAt - Date.now()), "expire", {
        userId: input.userId,
        roleId: role.id,
        expiresAt,
      });
      await ctx.kv.set(k, {
        userId: input.userId,
        roleId: role.id,
        request,
        expiresAt,
        job: job.id,
      });
    }
    await ensure(ctx, member, role, true, input.reason);
    return { userId: member.id, roleId: role.id, expiresAt };
  });
}

function policyWants(ctx: Context, m: Member, id: string) {
  return (
    Boolean(
      m.premiumSince && ctx.config.boost.role && resolve(ctx, ctx.config.boost.role).id === id,
    ) ||
    ctx.config.tenure.some(
      (rule) =>
        resolve(ctx, rule.role).id === id && Date.now() - m.joinedAt.getTime() >= rule.days * DAY,
    )
  );
}
async function end(ctx: Context, record: ActiveGrant, expired: boolean, reason?: string) {
  const role = resolve(ctx, record.roleId);
  await checkRole(ctx, role);
  const member = await ctx.server.member(record.userId);
  if (member && !policyWants(ctx, member, role.id)) await ensure(ctx, member, role, false, reason);
  const sk = stickyKey(record.userId);
  const sticky = await ctx.kv.get<string[]>(sk);
  if (sticky?.includes(role.id))
    await ctx.kv.set(
      sk,
      sticky.filter((id) => id !== role.id),
      { ttlSeconds: ctx.config.sticky.retentionDays * 86400 },
    );
  if (expired)
    await ctx.events.publish(
      "tempRoleExpired",
      { userId: record.userId, roleId: record.roleId, expiresAt: record.expiresAt },
      { version: 1, idempotencyKey: record.roleId + ":" + record.userId + ":" + record.expiresAt },
    );
  await ctx.kv.delete(grantKey(record.userId, record.roleId));
}
export async function expire(
  ctx: Context,
  p: { userId: string; roleId: string; expiresAt: number },
) {
  const k = grantKey(p.userId, p.roleId);
  return serial(k, async () => {
    const current = await ctx.kv.get<ActiveGrant>(k);
    if (!current || current.expiresAt !== p.expiresAt || current.expiresAt > Date.now()) return;
    await end(ctx, current, true);
  });
}
export async function revoke(ctx: Context, input: Revoke, actor?: Member) {
  const role = temporaryRole(ctx, input.role);
  const k = grantKey(input.userId, role.id);
  return serial(k, async () => {
    await checkRole(ctx, role, actor);
    const record = await ctx.kv.get<ActiveGrant>(k);
    if (!record) return { revoked: false };
    await end(ctx, record, false, input.reason);
    await ctx.schedule.cancel(record.job);
    return { revoked: true };
  });
}
export async function grants(ctx: Context, userId?: string): Promise<ActiveGrant[]> {
  const out: ActiveGrant[] = [];
  let cursor: string | undefined;
  do {
    const page = await ctx.kv.list<ActiveGrant>({
      prefix: userId ? `temporary:${userId}:` : "temporary:",
      cursor,
      limit: 100,
    });
    out.push(...page.items.map((v) => v.value));
    cursor = page.cursor;
  } while (cursor);
  return out;
}
export async function validateRoles(ctx: Context) {
  if (!ctx.config.enabled) return;
  for (const ref of new Set([
    ...ctx.config.sticky.roles,
    ...ctx.config.tenure.map((t) => t.role),
    ...ctx.config.temp.roles,
    ...(ctx.config.boost.role ? [ctx.config.boost.role] : []),
  ])) {
    await checkRole(ctx, resolve(ctx, ref));
  }
  if (ctx.config.boost.announce)
    ctx.features.report(
      "boostAnnouncements",
      ctx.features.enabled("boostAnnouncements"),
      translate(ctx, "status.boost"),
    );
}
async function remember(ctx: Context, m: Member, departed = false) {
  const ids = ctx.config.sticky.roles
    .map((r) => resolve(ctx, r))
    .filter((r) => m.hasRole({ id: r.id }))
    .map((r) => r.id);
  if (ids.length)
    await ctx.kv.set(
      stickyKey(m.id),
      ids,
      departed ? { ttlSeconds: ctx.config.sticky.retentionDays * 86400 } : undefined,
    );
  else await ctx.kv.delete(stickyKey(m.id));
}
export async function leave(ctx: Context, id: string, previous?: Member) {
  if (!ctx.config.enabled) return;
  await ctx.kv.delete(boostKey(id));
  if (previous) {
    await remember(ctx, previous, true);
    return;
  }
  const saved = await ctx.kv.get<string[]>(stickyKey(id));
  if (saved)
    await ctx.kv.set(stickyKey(id), saved, { ttlSeconds: ctx.config.sticky.retentionDays * 86400 });
}
export async function joined(ctx: Context, m: Member) {
  if (!ctx.config.enabled || m.user.bot) return;
  const configured = new Set(ctx.config.sticky.roles.map((ref) => resolve(ctx, ref).id));
  for (const r of await grants(ctx, m.id)) {
    if (r.expiresAt > Date.now()) await ensure(ctx, m, resolve(ctx, r.roleId), true);
    else await expire(ctx, r);
  }
  const saved = await ctx.kv.get<string[]>(stickyKey(m.id));
  for (const id of saved ?? [])
    if (configured.has(id)) await ensure(ctx, m, resolve(ctx, id), true);
  await changed(ctx, m);
}
export async function changed(ctx: Context, m: Member, bot?: Member) {
  if (!ctx.config.enabled || m.user.bot) return;
  for (const rule of ctx.config.tenure)
    if (Date.now() - m.joinedAt.getTime() >= rule.days * DAY)
      await ensure(ctx, m, resolve(ctx, rule.role), true, undefined, bot);
  if (ctx.config.boost.role) {
    const role = resolve(ctx, ctx.config.boost.role);
    const k = boostKey(m.id);
    if (m.premiumSince) {
      const old = await ctx.kv.get<string>(k);
      await ensure(ctx, m, role, true, undefined, bot);
      const since = m.premiumSince.toISOString();
      if (old !== since) {
        if (ctx.config.boost.announce && ctx.features.enabled("boostAnnouncements")) {
          await ctx.server.channel(ctx.config.boost.announce).send({
            content: translate(ctx, "boost"),
            allowedMentions: { users: false, roles: false, everyone: false },
            nonce: (m.id + ":" + m.premiumSince.getTime().toString(36)).slice(-25),
            enforceNonce: true,
          });
        }
        await ctx.kv.set(k, since);
      }
    } else if (await ctx.kv.get(k)) {
      const grant = await ctx.kv.get<ActiveGrant>(grantKey(m.id, role.id));
      if (!policyWants(ctx, m, role.id) && (!grant || grant.expiresAt <= Date.now()))
        await ensure(ctx, m, role, false, undefined, bot);
      await ctx.kv.delete(k);
    }
  }
  if (ctx.config.sticky.roles.length) await remember(ctx, m);
}
type Scan = { day: string; after: string; done: boolean };
export async function scan(ctx: Context) {
  if (
    !ctx.config.enabled ||
    (!ctx.config.tenure.length && !ctx.config.sticky.roles.length && !ctx.config.boost.role)
  )
    return;
  return serial("scan", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const previous = await ctx.kv.get<Scan>("scan");
    if (previous?.done && previous.day === today) return;
    const after = previous && !previous.done ? previous.after : "";
    const page = await ctx.server.members({ limit: BATCH, ...(after ? { after } : {}) });
    const bot = await ctx.server.member(ctx.bot.user.id);
    const started = Date.now();
    let processed = 0;
    let lastCheckpoint = started;
    let cursor = after;
    for (const m of page) {
      await changed(ctx, m, bot);
      cursor = m.id;
      processed++;
      const now = Date.now();
      if (now - lastCheckpoint >= 1000) {
        await ctx.kv.set("scan", { day: today, after: cursor, done: false });
        lastCheckpoint = now;
      }
      // Leave time within the runtime's handler deadline to persist and schedule the next page.
      if (now - started >= 4000) break;
    }
    const done = processed === page.length && page.length < BATCH;
    await ctx.kv.set("scan", { day: today, after: done ? "" : cursor, done });
    if (!done) await ctx.schedule.after(1000, "scan");
  });
}
export async function subjectData(ctx: Context, id: string, erase: boolean) {
  const result: Record<string, Json> = {};
  let erased = 0;
  const keys = [
    stickyKey(id),
    boostKey(id),
    ...(await grants(ctx, id)).map((r) => grantKey(id, r.roleId)),
  ];
  for (const k of keys) {
    const v = await ctx.kv.get(k);
    if (v === undefined) continue;
    result[k] = v;
    if (erase) {
      if (k.startsWith("temporary:")) await ctx.schedule.cancel((v as ActiveGrant).job);
      await ctx.kv.delete(k);
      erased++;
    }
  }
  const position = await ctx.kv.get<Scan>("scan");
  if (position?.after === id) {
    result.scan = position;
    if (erase) {
      await ctx.kv.set("scan", { ...position, after: "" });
      erased++;
    }
  }
  return { result, erased };
}
