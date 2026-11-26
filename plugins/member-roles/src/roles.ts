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
const scanNextKey = "scan:next";

/** A refusal the caller can act on. `code` maps to the interop error returned to plugins. */
export class Refusal extends Error {
  constructor(
    message: string,
    readonly code: "denied" | "invalid_input" = "denied",
  ) {
    super(message);
  }
}
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
function unassignable(ctx: Context, role: Role) {
  return (
    role.id === ctx.server.id ||
    role.managed !== false ||
    role.declaredMembers !== false ||
    role.position === undefined
  );
}
function assignable(ctx: Context, role: Role) {
  if (unassignable(ctx, role))
    throw new Refusal(translate(ctx, "error.unmanaged", { role: role.key ?? role.id }));
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
    throw new Refusal(translate(ctx, "error.hierarchy", { role: role.name }));
  if (actor && actor.id !== ctx.server.ownerId && !outranks(actor, role))
    throw new Refusal(translate(ctx, "error.hierarchy", { role: role.name }));
}
/** Why a configured role cannot be changed automatically, or undefined when it can. */
async function problem(ctx: Context, role: Role, bot?: Member): Promise<string | undefined> {
  if (unassignable(ctx, role)) return "status.unmanaged";
  const b = bot ?? (await ctx.server.member(ctx.bot.user.id));
  if (!b || !b.permissions?.includes("ManageRoles") || !outranks(b, role))
    return "status.hierarchy";
  return undefined;
}
function tryResolve(ctx: Context, ref: string): Role | undefined {
  try {
    return resolve(ctx, ref);
  } catch {
    return undefined;
  }
}
export async function manager(ctx: Context, actor?: Member) {
  if (!ctx.config.enabled || !actor) throw new Refusal(translate(ctx, "error.disabled"));
  if (actor.id === ctx.server.ownerId) return;
  const allowed = ctx.config.temp.managerRoles;
  if (
    allowed.length
      ? !allowed.some((ref) => actor.hasRole(roleRef(ref)))
      : !actor.permissions?.includes("ManageRoles")
  )
    throw new Refusal(translate(ctx, "error.denied"));
}
/**
 * Inter-plugin calls never get the "every assignable role" default: a caller granted
 * plugins.call could otherwise hand out any role below the bot, including one carrying
 * Administrator. The operator lists the roles other plugins may grant in temp.roles.
 */
/** Bit index of each Discord permission that makes a role a privilege (MOD-09). */
const PRIVILEGED = {
  KickMembers: 1n,
  BanMembers: 2n,
  Administrator: 3n,
  ManageChannels: 4n,
  ManageGuild: 5n,
  MentionEveryone: 17n,
  ManageRoles: 28n,
  ManageWebhooks: 29n,
  ModerateMembers: 40n,
} as const;
/**
 * The privileged permissions a role grants, from its decimal bitfield. Undefined when the
 * runtime does not know them (not cached yet, or an older engine): unknown, never "none".
 */
export function privileges(role: Role): string[] | undefined {
  const raw = role.permissions;
  if (typeof raw !== "string" || !/^\d{1,30}$/.test(raw)) return undefined;
  const bits = BigInt(raw);
  return Object.entries(PRIVILEGED)
    .filter(([, bit]) => (bits >> bit) & 1n)
    .map(([name]) => name);
}
/** temp.privilegedRoles: the explicit opt-in to grant a privileged role temporarily. */
function optedIn(ctx: Context, role: Role) {
  return ctx.config.temp.privilegedRoles.some((key) => tryResolve(ctx, key)?.id === role.id);
}
/**
 * A temporary grant never hands out moderation or administration power by accident: a role
 * with a privileged permission, or whose permissions are unknown, is refused (fail closed)
 * unless temp.privilegedRoles lists it.
 */
function unprivileged(ctx: Context, role: Role) {
  if (optedIn(ctx, role)) return;
  const found = privileges(role);
  if (found === undefined)
    throw new Refusal(translate(ctx, "error.permissionsUnknown", { role: role.name }));
  if (found.length)
    throw new Refusal(
      translate(ctx, "error.privileged", { role: role.name, permissions: found.join(", ") }),
    );
}
function temporaryRole(ctx: Context, ref: string, interop = false) {
  if (!ctx.config.enabled) throw new Refusal(translate(ctx, "error.disabled"));
  if (interop && !ctx.config.temp.roles.length)
    throw new Refusal(translate(ctx, "error.interopAllowlist"));
  const r = tryResolve(ctx, ref);
  if (!r) throw new Refusal(translate(ctx, "error.denied"));
  if (
    ctx.config.temp.roles.length &&
    !ctx.config.temp.roles.some((key) => tryResolve(ctx, key)?.id === r.id)
  )
    throw new Refusal(translate(ctx, "error.denied"));
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
/** Policy changes (sticky, tenure, boost) skip a role reported at startup instead of
 * failing the member event or the scan page that carries every other member. */
async function apply(ctx: Context, member: Member, ref: string, present: boolean, bot?: Member) {
  const role = tryResolve(ctx, ref);
  if (!role || member.hasRole({ id: role.id }) === present) return;
  if (await problem(ctx, role, bot)) return;
  await ensure(ctx, member, role, present, undefined, bot);
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
export async function grant(
  ctx: Context,
  input: Grant,
  key: string,
  actor?: Member,
  interop = false,
) {
  const role = temporaryRole(ctx, input.role, interop);
  unprivileged(ctx, role);
  if (
    !Number.isSafeInteger(input.durationSeconds) ||
    input.durationSeconds < 1 ||
    input.durationSeconds > ctx.config.temp.maxDays * 86400
  )
    throw new Refusal(
      translate(ctx, "error.duration", { days: ctx.config.temp.maxDays }),
      "invalid_input",
    );
  return serial(grantKey(input.userId, role.id), async () => {
    await checkRole(ctx, role, actor);
    const member = await ctx.server.member(input.userId);
    if (!member) throw new Refusal(translate(ctx, "error.member"));
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
      m.premiumSince && ctx.config.boost.role && tryResolve(ctx, ctx.config.boost.role)?.id === id,
    ) ||
    ctx.config.tenure.some(
      (rule) =>
        tryResolve(ctx, rule.role)?.id === id &&
        Date.now() - m.joinedAt.getTime() >= rule.days * DAY,
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
export async function revoke(ctx: Context, input: Revoke, actor?: Member, interop = false) {
  const role = temporaryRole(ctx, input.role, interop);
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
/**
 * Never throws: each refused role gets its own instance status line naming it and the
 * reason, and only the rules using that role skip it. The other roles keep working.
 * Returns the refused role references.
 */
export async function validateRoles(ctx: Context): Promise<string[]> {
  if (!ctx.config.enabled) return [];
  const refused: string[] = [];
  const bot = await ctx.server.member(ctx.bot.user.id);
  for (const ref of new Set([
    ...ctx.config.sticky.roles,
    ...ctx.config.tenure.map((t) => t.role),
    ...ctx.config.temp.roles,
    ...(ctx.config.boost.role ? [ctx.config.boost.role] : []),
  ])) {
    const role = tryResolve(ctx, ref);
    const reason = role ? await problem(ctx, role, bot) : "status.missing";
    ctx.status.set(
      "role:" + ref,
      reason ? translate(ctx, reason, { role: role?.name ?? ref }) : null,
    );
    if (reason) refused.push(ref);
  }
  // Temporary roles with a privileged permission are refused at grant time unless opted in.
  for (const ref of ctx.config.temp.roles) {
    const role = tryResolve(ctx, ref);
    const found = role && !optedIn(ctx, role) ? privileges(role) : undefined;
    ctx.status.set(
      "privileged:" + ref,
      role && found?.length
        ? translate(ctx, "status.privileged", { role: role.name, permissions: found.join(", ") })
        : null,
    );
  }
  if (ctx.config.boost.announce) {
    const active = ctx.features.enabled("boostAnnouncements");
    ctx.features.report(
      "boostAnnouncements",
      active,
      active ? undefined : translate(ctx, "status.boost"),
    );
  }
  return refused;
}
async function remember(ctx: Context, m: Member, departed = false) {
  const ids = ctx.config.sticky.roles
    .map((r) => tryResolve(ctx, r))
    .filter((r): r is Role => !!r && m.hasRole({ id: r.id }))
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
  const configured = new Set(ctx.config.sticky.roles.map((ref) => tryResolve(ctx, ref)?.id));
  for (const r of await grants(ctx, m.id)) {
    if (r.expiresAt > Date.now()) await apply(ctx, m, r.roleId, true);
    else await expire(ctx, r);
  }
  const saved = await ctx.kv.get<string[]>(stickyKey(m.id));
  for (const id of saved ?? []) if (configured.has(id)) await apply(ctx, m, id, true);
  await changed(ctx, m);
}
export async function changed(ctx: Context, m: Member, bot?: Member) {
  if (!ctx.config.enabled || m.user.bot) return;
  for (const rule of ctx.config.tenure)
    if (Date.now() - m.joinedAt.getTime() >= rule.days * DAY)
      await apply(ctx, m, rule.role, true, bot);
  const role = ctx.config.boost.role ? tryResolve(ctx, ctx.config.boost.role) : undefined;
  if (role) {
    const k = boostKey(m.id);
    if (m.premiumSince) {
      const old = await ctx.kv.get<string>(k);
      await apply(ctx, m, role.id, true, bot);
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
        await apply(ctx, m, role.id, false, bot);
      await ctx.kv.delete(k);
    }
  }
  if (ctx.config.sticky.roles.length) await remember(ctx, m);
}
type Scan = { day: string; after: string; done: boolean };
/**
 * Startup and the five-minute cron start a scan only when no page chain is alive. Each
 * unfinished page schedules the next one with `chain` set and refreshes a short lease,
 * so a crashed chain is restarted by the next tick instead of every tick adding a chain.
 */
export async function scan(ctx: Context, chain = false) {
  if (
    !ctx.config.enabled ||
    (!ctx.config.tenure.length && !ctx.config.sticky.roles.length && !ctx.config.boost.role)
  )
    return;
  return serial("scan", async () => {
    if (!chain && (await ctx.kv.get(scanNextKey))) return;
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
    if (done) await ctx.kv.delete(scanNextKey);
    else {
      await ctx.kv.set(scanNextKey, true, { ttlSeconds: 120 });
      await ctx.schedule.after(1000, "scan", "chain");
    }
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
    if (!erase) continue;
    if (k.startsWith("temporary:")) {
      // Retained until it expires: erasing the record and its job would leave the
      // Discord role in place forever, turning a timed grant or restriction permanent.
      // Only the opaque request token goes; the job still removes the role on schedule.
      const g = v as ActiveGrant;
      if (g.request) {
        await ctx.kv.set(k, { ...g, request: "" });
        erased++;
      }
      continue;
    }
    await ctx.kv.delete(k);
    erased++;
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
