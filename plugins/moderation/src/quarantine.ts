import type { AuditLogEntry, Context, Json, Member } from "@cicord/sdk";
import { who, editCase, readCase, saveNewCase, type Case } from "./moderation.ts";
import { serialize } from "./queue.ts";

export class QuarantineRefusal extends Error {}

type Quarantine = {
  number: number;
  user: string;
  role: string;
  until: string;
  restore: string[];
  // Gateway updates from our removals are asynchronous. Persist the expected echo.
  removing: string[];
  overlay: boolean;
  pending?: Case;
  task?: string;
  caseOnlyTasks?: boolean;
  redacted?: boolean;
};
const key = (user: string) => "quarantine:" + user;
const bindingKey = (number: number) => "quarantine-case:" + number;
const overlayId = (user: string) => "quarantine-" + user;
const save = (ctx: Context, q: Quarantine) => ctx.kv.set(key(q.user), q as unknown as Json);

async function checkedTarget(ctx: Context, m: Member) {
  const roleKey = ctx.config.quarantineRole;
  if (!roleKey || !ctx.features.enabled("quarantine"))
    throw new QuarantineRefusal(ctx.i18n.t("quarantine.configure"));
  const role = ctx.server.role(roleKey);
  if (
    !role ||
    role.position === undefined ||
    role.managed ||
    role.declaredMembers ||
    role.id === ctx.server.id
  )
    throw new QuarantineRefusal(ctx.i18n.t("quarantine.role"));
  const bot = await ctx.server.member(ctx.bot.user.id);
  if (!bot || bot.roles.some((r) => r.position === undefined))
    throw new QuarantineRefusal(ctx.i18n.t("quarantine.hierarchy"));
  const top = Math.max(0, ...bot.roles.map((r) => r.position!));
  if (role.position >= top || m.roles.some((r) => r.position === undefined || r.position >= top))
    throw new QuarantineRefusal(ctx.i18n.t("quarantine.above"));
  if (
    m.declaredRoles === undefined ||
    m.roles.some(
      (r) =>
        r.managed === undefined ||
        (r.declaredMembers && (!r.key || !m.declaredRoles?.includes(r.key))),
    )
  )
    throw new QuarantineRefusal(ctx.i18n.t("quarantine.uncertain"));
  if (m.declaredRoles.length && !ctx.features.enabled("lock"))
    throw new QuarantineRefusal(ctx.i18n.t("quarantine.overlay"));
  if (m.roles.some((r) => r.managed)) throw new QuarantineRefusal(ctx.i18n.t("quarantine.managed"));
  return role;
}

export async function quarantine(
  ctx: Context,
  m: Member,
  reason: string,
  minutes: number,
  moderator: Case["moderator"],
  source: Case["source"],
) {
  return serialize(key(m.id), async () => {
    const current = await ctx.server.member(m.id);
    if (!current) throw new QuarantineRefusal(ctx.i18n.t("quarantine.left"));
    const role = await checkedTarget(ctx, current);
    if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > 10080)
      throw new QuarantineRefusal(ctx.i18n.t("quarantine.duration"));
    const old = await ctx.kv.get<Quarantine>(key(m.id));
    if (old && old.role !== role.id)
      throw new QuarantineRefusal(ctx.i18n.t("quarantine.releaseFirst"));
    const number = await ctx.kv.increment("cases");
    const until = new Date(Date.now() + minutes * 60000).toISOString();
    const remove = current.roles
      .filter((r) => !r.declaredMembers && r.id !== role.id && r.id !== ctx.server.id)
      .map((r) => r.id);
    const q: Quarantine = {
      user: m.id,
      number,
      role: role.id,
      until,
      restore: [...new Set([...(old?.restore ?? []), ...remove])],
      removing: [...new Set([...(old?.removing ?? []), ...remove])],
      overlay: !!current.declaredRoles?.length || !!old?.overlay,
    };
    const c: Case = {
      number,
      at: new Date().toISOString(),
      member: who(m.user, m.displayName),
      moderator,
      reason,
      action: "quarantine",
      status: "active",
      source,
      expiresAt: until,
    };
    q.pending = c;
    // Both handlers inspect the case generation. Scheduling them before persisting
    // intent makes a crash before the first Discord request harmless.
    await scheduleCaseTasks(ctx, q);
    const tx = ctx.kv
      .atomic()
      .set(key(m.id), q as unknown as Json)
      .set(bindingKey(number), m.id);
    if (old) tx.delete(bindingKey(old.number));
    await tx.commit();
    await enforce(ctx, q, current);
    if (old) {
      if (old.task) await ctx.schedule.cancel(old.task);
      const prior = await readCase(ctx, old.number);
      if (prior) await editCase(ctx, prior.number, { status: "superseded" });
    }
    return c;
  });
}

async function scheduleCaseTasks(ctx: Context, q: Quarantine) {
  if (q.pending) await ctx.schedule.after(1000, "applyQuarantine", { number: q.number });
  const delay = Math.max(1, Date.parse(q.until) - Date.now());
  const expiry = await ctx.schedule.after(delay, "expireQuarantine", { number: q.number });
  q.task = expiry.id;
  q.caseOnlyTasks = true;
}

/** Legacy jobs carried a Discord user ID. Keep the replacement wakeups independent
 * of the privacy API's subsequent removal of member-bearing task payloads. */
export async function preserveQuarantineForErasure(ctx: Context, user: string, deleted: string) {
  await serialize(key(user), async () => {
    const q = await ctx.kv.get<Quarantine>(key(user));
    if (!q) return;
    if (!q.caseOnlyTasks) await scheduleCaseTasks(ctx, q);
    q.redacted = true;
    // The runtime keeps the subject only while its declared assignments must stay suspended.
    if (q.overlay && Date.parse(q.until) > Date.now())
      await ctx.server.overlays.apply({
        id: overlayId(user),
        reason: ctx.i18n.t("quarantine.caseReason", { number: q.number }),
        until: new Date(q.until),
        members: { [user]: { suspendDeclaredRoles: true } },
      });
    if (q.pending) {
      q.pending.reason = "";
      delete q.pending.evidence;
      delete q.pending.evidenceChannelId;
      q.pending.member = { id: deleted, name: ctx.i18n.t("case.deletedUser") };
      if (q.pending.moderator?.id === user)
        q.pending.moderator = { id: deleted, name: ctx.i18n.t("case.deletedUser") };
    }
    await ctx.kv
      .atomic()
      .set(key(user), q as unknown as Json)
      .set(bindingKey(q.number), user)
      .commit();
  });
}

export async function quarantineTask(ctx: Context, payload: Json | undefined, apply: boolean) {
  const p = payload as { number?: number; user?: string } | undefined;
  if (!p?.number || !Number.isSafeInteger(p.number)) throw new Error("Invalid quarantine case.");
  const user = (await ctx.kv.get<string>(bindingKey(p.number))) ?? p.user;
  if (!user) return;
  if (apply) await recoverQuarantine(ctx, user, p.number);
  else await release(ctx, user, p.number, null, "Quarantine expired", true);
}
async function enforce(ctx: Context, q: Quarantine, m: Member) {
  const c = q.pending;
  if (!c || Date.parse(q.until) <= Date.now()) return;
  if (q.overlay)
    await ctx.server.overlays.apply({
      id: overlayId(m.id),
      reason: ctx.i18n.t("quarantine.caseReason", { number: q.number }),
      until: new Date(q.until),
      members: { [m.id]: { suspendDeclaredRoles: true } },
    });
  if (!m.hasRole({ id: q.role })) await m.addRole({ id: q.role }, c.reason);
  for (const id of q.removing) if (m.hasRole({ id })) await m.removeRole({ id }, c.reason);
  await saveNewCase(ctx, c);
  delete q.pending;
  await save(ctx, q);
}
export async function recoverQuarantine(ctx: Context, user: string, number: number) {
  await serialize(key(user), async () => {
    const q = await ctx.kv.get<Quarantine>(key(user));
    if (!q?.pending || q.number !== number) return;
    const m = await ctx.server.member(user);
    if (m) await enforce(ctx, q, m);
  });
}

export async function release(
  ctx: Context,
  user: string,
  expected: number | undefined,
  moderator: Case["moderator"],
  reason: string,
  expired = false,
) {
  return serialize(key(user), async () => {
    const q = await ctx.kv.get<Quarantine>(key(user));
    if (!q || (expected !== undefined && q.number !== expected)) return false;
    const m = await ctx.server.member(user);
    if (q.redacted) await ctx.kv.set("quarantine-release-echo:" + user, true, { ttlSeconds: 120 });
    if (m) {
      for (const id of q.restore) {
        const role = ctx.server.role({ id });
        if (!role || role.position === undefined || role.declaredMembers || role.managed) continue;
        if (!m.hasRole({ id })) await m.addRole({ id }, reason);
      }
      if (m.hasRole({ id: q.role })) await m.removeRole({ id: q.role }, reason);
    }
    if (q.overlay) await ctx.server.overlays.remove(overlayId(user));
    const c = await readCase(ctx, q.number);
    if (c) {
      c.status = expired ? "expired" : "lifted";
      await editCase(ctx, q.number, { status: c.status });
      await ctx.events.publish("caseUpdated", {
        number: q.number,
        changes: ["status"],
        by: moderator?.id ?? "cicord",
      });
    }
    await ctx.kv.atomic().delete(key(user)).delete(bindingKey(q.number)).commit();
    if (q.task && !expired) await ctx.schedule.cancel(q.task);
    return true;
  });
}

export async function trackQuarantine(ctx: Context, m: Member, before: Member | undefined) {
  if (!before) return;
  await serialize(key(m.id), async () => {
    const q = await ctx.kv.get<Quarantine>(key(m.id));
    if (!q) return;
    const was = new Set(before.roles.map((r) => r.id)),
      now = new Set(m.roles.map((r) => r.id));
    for (const r of before.roles)
      if (!now.has(r.id)) {
        if (q.removing.includes(r.id)) {
          q.removing = q.removing.filter((id) => id !== r.id);
          continue;
        }
        q.restore = q.restore.filter((id) => id !== r.id);
      }
    for (const role of m.roles) {
      if (was.has(role.id) || role.declaredMembers || role.managed || role.id === q.role) continue;
      // A subsequent grant supersedes our pending removal echo.
      q.removing = q.removing.filter((id) => id !== role.id);
      if (!q.restore.includes(role.id)) q.restore.push(role.id);
    }
    await save(ctx, q);
  });
}
// Confirmed human audit entries also capture staff removals racing a plugin-generated echo.
export async function staffRoleChange(ctx: Context, e: AuditLogEntry) {
  if (
    e.action !== "member.roleUpdate" ||
    !e.targetId ||
    e.attribution.kind !== "human" ||
    e.attribution.certainty !== "confirmed"
  )
    return;
  const user = e.targetId;
  await serialize(key(user), async () => {
    const q = await ctx.kv.get<Quarantine>(key(user));
    if (!q) return;
    const c = await readCase(ctx, q.number);
    if (!c || +e.at < Date.parse(c.at)) return;
    for (const v of e.changes) {
      if (v.key !== "$remove" || !Array.isArray(v.new)) continue;
      const ids = new Set(
        v.new.map((value) =>
          value && typeof value === "object" && !Array.isArray(value) ? value.id : undefined,
        ),
      );
      q.restore = q.restore.filter((id) => !ids.has(id));
      q.removing = q.removing.filter((id) => !ids.has(id));
    }
    await save(ctx, q);
  });
}

/**
 * Discord drops every role when a member leaves. A returning member with an active
 * quarantine gets the quarantine role back, and roles granted on return (sticky or
 * automatic roles) are suspended with the saved set until the release.
 */
export async function rejoinQuarantine(ctx: Context, m: Member) {
  await serialize(key(m.id), async () => {
    const q = await ctx.kv.get<Quarantine>(key(m.id));
    if (!q || Date.parse(q.until) <= Date.now()) return;
    const extra = m.roles
      .filter((r) => !r.declaredMembers && !r.managed && r.id !== q.role && r.id !== ctx.server.id)
      .map((r) => r.id);
    q.restore = [...new Set([...q.restore, ...extra])];
    q.removing = [...new Set([...q.removing, ...extra])];
    await save(ctx, q);
    const reason = ctx.i18n.t("quarantine.caseReason", { number: q.number });
    if (!m.hasRole({ id: q.role })) await m.addRole({ id: q.role }, reason);
    for (const id of extra) if (m.hasRole({ id })) await m.removeRole({ id }, reason);
  });
}

export async function excludeSavedRole(ctx: Context, user: string, role: string) {
  return serialize(key(user), async () => {
    const q = await ctx.kv.get<Quarantine>(key(user));
    if (!q) return false;
    q.restore = q.restore.filter((id) => id !== role);
    q.removing = q.removing.filter((id) => id !== role);
    await save(ctx, q);
    return true;
  });
}

export async function hideErasedActivity(ctx: Context, user: string) {
  return (
    !!(await ctx.kv.get<Quarantine>(key(user)))?.redacted ||
    !!(await ctx.kv.get("quarantine-release-echo:" + user))
  );
}
