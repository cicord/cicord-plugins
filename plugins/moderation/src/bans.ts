import type { AuditLogEntry, Context, Json } from "@cicord/sdk";
import { caseTTL, recordCase, saveNewCase, withModerationLock, type Case } from "./moderation.ts";

type Person = NonNullable<Case["member"]>;
type BanProof = { entryId: string; actorId: string; checkedAt: number; entryAt?: number };
type Expiry = {
  sanction: Case;
  taskId?: string;
  release?: Case;
  floor?: string;
  supersedes?: number;
  caseSaved?: boolean;
  proof?: BanProof;
  nextCheck?: number;
};

type BanOptions = { source?: Case["source"]; beforeDiscord?(sanction: Case): Promise<void> };

const DAY = 86_400_000;
const WEEK = 7 * DAY;
const pending = new Map<string, Promise<void>>();
const activeKey = (user: string) => `active-ban:${user}`;
const expiryKey = (number: number) => `ban-expiry:${number}`;
const marker = (c: Case) => `[cicord ${c.action} #${c.number}] `;

/** Serialize Discord and KV changes for one member across concurrent commands and tasks. */
async function forMember<T>(ctx: Context, user: string, work: () => Promise<T>): Promise<T> {
  const previous = pending.get(user) ?? Promise.resolve();
  let unlock!: () => void;
  const gate = new Promise<void>((resolve) => {
    unlock = resolve;
  });
  const tail = previous.then(() => gate);
  pending.set(user, tail);
  await previous;
  try {
    return await withModerationLock(ctx, `ban-lock:${user}`, work);
  } finally {
    unlock();
    if (pending.get(user) === tail) pending.delete(user);
  }
}

async function setStatus(ctx: Context, number: number, status: Case["status"]) {
  const key = `case:${number}`;
  for (let i = 0; i < 5; i++) {
    const old = await ctx.kv.getEntry<Case>(key);
    if (!old || old.value.status === status || old.value.status === "void") return;
    const ttlSeconds = caseTTL(old.value.at);
    if (!ttlSeconds) return;
    if (
      (
        await ctx.kv
          .atomic()
          .check(key, old.version)
          .set(key, { ...old.value, status } as Json, { ttlSeconds })
          .commit()
      ).ok
    )
      return;
  }
  throw new Error("Case changed while recording ban status");
}

async function retire(ctx: Context, p: Expiry, status: "lifted" | "superseded" | "expired") {
  await setStatus(ctx, p.sanction.number, status);
  const user = p.sanction.member!.id;
  const key = activeKey(user);
  const current = await ctx.kv.getEntry<number>(key);
  if (current?.value === p.sanction.number)
    await ctx.kv.atomic().check(key, current.version).delete(key).commit();
  await ctx.kv.delete(expiryKey(p.sanction.number));
  if (p.taskId) await ctx.schedule.cancel(p.taskId);
}

async function currentBan(ctx: Context, user: string) {
  const [entry] = await ctx.server.bans({ after: String(BigInt(user) - 1n), limit: 1 });
  return entry?.user.id === user ? entry : undefined;
}

function hasMarker(ctx: Context, c: Case, reason?: string) {
  const prefix = marker(c);
  return (
    !!reason &&
    (reason.startsWith(prefix) ||
      reason.startsWith(`cicord: ${ctx.bot.key}/${ctx.plugin.instance}: ${prefix}`))
  );
}

function confirmedInstallation(ctx: Context, event: AuditLogEntry): boolean {
  const origin = event.attribution.plugin;
  return (
    !event.mergeable &&
    event.actorId === ctx.bot.user.id &&
    event.attribution.kind === "cicord" &&
    event.attribution.certainty === "confirmed" &&
    origin?.bot === ctx.bot.key &&
    origin.instance === ctx.plugin.instance &&
    origin.plugin === ctx.plugin.name
  );
}

// Discord has no target filter. An incomplete scan cannot establish that no intervening
// ban or unban occurred. The overlap includes audit entries arriving after a checkpoint.
async function latest(
  ctx: Context,
  action: string,
  user: string,
  since: number,
): Promise<AuditLogEntry | undefined> {
  let before: string | undefined;
  for (let page = 0; page < 5; page++) {
    const rows = await ctx.server.auditLog({ action, limit: 100, ...(before ? { before } : {}) });
    for (const row of rows) {
      if (row.at.getTime() < since) return undefined;
      if (row.targetId === user) return row;
    }
    if (rows.length < 100) return undefined;
    before = rows[rows.length - 1]!.id;
  }
  throw new Error("Ban audit history exceeds the verification window; staff review required");
}

type Check = { kind: "verified"; proof: BanProof } | { kind: "replaced" | "absent" | "pending" };

async function checkBan(ctx: Context, p: Expiry): Promise<Check> {
  const c = p.sanction,
    user = c.member!.id;
  if (((await ctx.kv.get<number>(activeKey(user))) ?? 0) > c.number) return { kind: "replaced" };
  const remote = await currentBan(ctx, user);
  if (!remote) return { kind: "absent" };
  if (!hasMarker(ctx, c, remote.reason)) return { kind: "replaced" };
  const now = Date.now();
  const since = (p.proof?.checkedAt ?? Date.parse(c.at)) - 120_000;
  // Discord keeps an audit entry for 45 days. Do not infer continuity across
  // an outage longer than our verified history, even for an identical ban reason.
  if (!Number.isFinite(since) || now - since >= 44 * DAY) return { kind: "pending" };
  const ban = await latest(ctx, "member.ban", user, since);
  const lift = await latest(ctx, "member.unban", user, since);
  if (p.proof) {
    const original = BigInt(p.proof.entryId);
    if (p.proof.actorId !== ctx.bot.user.id) return { kind: "pending" };
    if (
      (!ban && (p.proof.entryAt ?? Date.parse(c.at)) >= since) ||
      (ban && BigInt(ban.id) < original)
    )
      return { kind: "pending" };
    if ((ban && BigInt(ban.id) > original) || (lift && BigInt(lift.id) > original))
      return { kind: "replaced" };
    if (ban && BigInt(ban.id) === original && ban.actorId !== p.proof.actorId)
      return { kind: "pending" };
    return { kind: "verified", proof: { ...p.proof, checkedAt: now } };
  }
  if (!ban || BigInt(ban.id) <= BigInt(p.floor ?? "0")) return { kind: "pending" };
  if (lift && BigInt(lift.id) > BigInt(ban.id)) return { kind: "pending" };
  if (!hasMarker(ctx, c, ban.reason) || !confirmedInstallation(ctx, ban))
    return { kind: "pending" };
  return {
    kind: "verified",
    proof: { entryId: ban.id, actorId: ctx.bot.user.id, entryAt: ban.at.getTime(), checkedAt: now },
  };
}

const store = (ctx: Context, p: Expiry) =>
  ctx.kv.set(expiryKey(p.sanction.number), p as unknown as Json);

// Repair a successful Discord side effect even if its command died before
// updating the active pointer, saving the case or retiring the preceding case.
async function materialize(ctx: Context, p: Expiry) {
  const user = p.sanction.member!.id;
  const number = p.sanction.number;
  const active = await ctx.kv.get<number>(activeKey(user));
  if (active !== undefined && active > number) return;
  await ctx.kv.set(activeKey(user), number);
  if (!p.caseSaved) {
    await saveNewCase(ctx, p.sanction);
    p.caseSaved = true;
    const c = p.sanction;
    // Keep only what an expiration, checkpoint or conditional release needs.
    // Case history owns the names, reason, moderator, evidence and its own TTL.
    p.sanction = {
      number: c.number,
      action: c.action,
      at: c.at,
      member: { id: user, name: "" },
      moderator: null,
      reason: "",
      ...(c.expiresAt ? { expiresAt: c.expiresAt } : {}),
    };
    await store(ctx, p);
  }
  if (p.supersedes && p.supersedes !== number) {
    const prior = await ctx.kv.get<Expiry>(expiryKey(p.supersedes));
    if (prior) await retire(ctx, prior, "superseded");
    else await setStatus(ctx, p.supersedes, "superseded");
  }
}
async function checkpoint(ctx: Context, p: Expiry, result: Check) {
  if (result.kind === "absent" || result.kind === "replaced") {
    await retire(ctx, p, result.kind === "absent" ? "lifted" : "superseded");
    return;
  }
  let delay: number;
  if (result.kind === "verified") {
    p.proof = result.proof;
    // A long or permanent ban must periodically reestablish continuity before
    // Discord expires its audit history. Short bans are checked again on expiry.
    delay = WEEK;
    if (p.sanction.expiresAt && Date.parse(p.sanction.expiresAt) <= Date.now() + delay) {
      delete p.nextCheck;
      await store(ctx, p);
      return;
    }
  } else {
    if (Date.now() - Date.parse(p.sanction.at) > 180_000)
      throw new Error("Ban ownership could not be confirmed; staff review required");
    delay = 20_000;
  }
  p.nextCheck = Date.now() + delay;
  await ctx.schedule.after(delay, "bindBanEvidence", {
    number: p.sanction.number,
    user: p.sanction.member!.id,
    check: p.nextCheck,
  });
  await store(ctx, p);
}

export async function bindBanEvidence(ctx: Context, payload?: Json) {
  const job = payload as
    | { number: number; user: string; check?: number; release?: number }
    | undefined;
  if (!job || !Number.isSafeInteger(job.number) || typeof job.user !== "string")
    throw new Error("Invalid ban evidence task");
  await forMember(ctx, job.user, async () => {
    const p = await ctx.kv.get<Expiry>(expiryKey(job.number));
    if (!p || p.sanction.member?.id !== job.user) return;
    if (job.release !== undefined) {
      if (p.release?.number === job.release)
        await releaseCurrent(ctx, job.user, job.number, p.release.moderator, p.release.reason);
      return;
    }
    if (job.check === undefined || p.nextCheck !== job.check) return;
    if (p.release) return; // The resolution has its own recovery task.
    const result = await checkBan(ctx, p);
    if (result.kind === "verified") await materialize(ctx, p);
    await checkpoint(ctx, p, result);
  });
}

export async function applyBan(
  ctx: Context,
  member: Person,
  moderator: Case["moderator"],
  reason: string,
  deleteMessages: boolean,
  minutes?: number,
  options: BanOptions = {},
) {
  return forMember(ctx, member.id, async () => {
    const previous = await ctx.kv.get<number>(activeKey(member.id));
    const [before] = await ctx.server.auditLog({ action: "member.ban", limit: 1 });
    const number = await ctx.kv.increment("cases"),
      at = new Date();
    const c: Case = {
      number,
      at: at.toISOString(),
      action: minutes ? "tempban" : "ban",
      member,
      moderator,
      reason,
      status: "active",
      source: options.source ?? { type: moderator ? "command" : "escalation" },
      ...(minutes
        ? { durationMinutes: minutes, expiresAt: new Date(+at + minutes * 60000).toISOString() }
        : {}),
    };
    const p: Expiry = {
      sanction: c,
      floor: before?.id ?? "0",
      nextCheck: at.getTime() + 20_000,
      ...(previous ? { supersedes: previous } : {}),
    };
    if (minutes)
      p.taskId = (
        await ctx.schedule.after(minutes * 60000, "expireBan", { number, user: member.id })
      ).id;
    await ctx.schedule.after(20_000, "bindBanEvidence", {
      number,
      user: member.id,
      check: p.nextCheck!,
    });
    await store(ctx, p);
    await options.beforeDiscord?.(c);
    const auditReason = marker(c) + `${moderator?.name ?? "automatic"}: ${reason || "no reason"}`;
    await ctx.server.ban(member.id, {
      reason: Array.from(auditReason).slice(0, 512).join(""),
      ...(deleteMessages ? { deleteMessagesSeconds: 86400 } : {}),
    });
    await materialize(ctx, p);
    // The durable evidence task owns recovery if Discord's audit entry is late.
    try {
      const result = await checkBan(ctx, p);
      if (result.kind === "verified") await checkpoint(ctx, p, result);
    } catch {
      ctx.log.warn("Ban evidence will be retried", { number });
    }
    return c;
  });
}

async function releaseCurrent(
  ctx: Context,
  user: string,
  number: number,
  moderator: Person | null,
  reason: string,
) {
  const p = await ctx.kv.get<Expiry>(expiryKey(number));
  if (!p || p.sanction.member?.id !== user) return false;
  const result = await checkBan(ctx, p);
  if (result.kind === "pending") throw new Error("Ban ownership is unconfirmed; release deferred");
  if (result.kind === "replaced" || (result.kind === "absent" && !p.release)) {
    await retire(ctx, p, result.kind === "absent" ? "lifted" : "superseded");
    return false;
  }
  if (!p.release) {
    if (result.kind !== "verified") return false;
    p.proof = result.proof;
    p.release = {
      number: await ctx.kv.increment("cases"),
      at: new Date().toISOString(),
      action: "unban",
      member: (await ctx.kv.get<Case>(`case:${number}`))?.member ?? p.sanction.member,
      moderator,
      reason,
      status: "lifted",
      source: { type: moderator ? "command" : "escalation" },
    };
    await ctx.schedule.after(20_000, "bindBanEvidence", {
      number,
      user,
      release: p.release.number,
    });
    await store(ctx, p);
  }
  if (result.kind === "verified") {
    // Reserving a release can involve several writes. Re-check after those writes,
    // immediately before Discord's unconditional remove-ban operation.
    const final = await checkBan(ctx, p);
    if (final.kind === "pending") throw new Error("Ban ownership is unconfirmed; release deferred");
    if (final.kind !== "verified") {
      await retire(ctx, p, final.kind === "absent" ? "lifted" : "superseded");
      return false;
    }
    await ctx.server.unban(user, marker(p.release) + p.release.reason);
  }
  // A missing ban is not proof that our remove succeeded. A moderator may have
  // lifted it while our request was in flight or before this worker resumed.
  const receipt = await latest(ctx, "member.unban", user, Date.parse(p.release.at) - 30_000);
  if (
    !receipt ||
    (p.proof && BigInt(receipt.id) <= BigInt(p.proof.entryId)) ||
    receipt.attribution.certainty !== "confirmed"
  )
    throw new Error("Awaiting release audit evidence");
  if (!confirmedInstallation(ctx, receipt) || !hasMarker(ctx, p.release, receipt.reason)) {
    await retire(ctx, p, "lifted");
    return false;
  }
  if (!p.caseSaved) await saveNewCase(ctx, p.sanction);
  await saveNewCase(ctx, p.release);
  await retire(ctx, p, p.release.moderator ? "lifted" : "expired");
  return true;
}

export async function expireBan(ctx: Context, number: number, user: string) {
  await forMember(ctx, user, () =>
    releaseCurrent(ctx, user, number, null, `Temporary ban #${number} expired`),
  );
}

export async function liftBanIfCurrent(
  ctx: Context,
  user: string,
  number: number,
  moderator: Person,
  reason: string,
): Promise<boolean> {
  return forMember(ctx, user, () => releaseCurrent(ctx, user, number, moderator, reason));
}

/** Explicit staff /unban is authorized to lift the current ban regardless of its origin. */
export async function liftBan(ctx: Context, member: Person, moderator: Person, reason: string) {
  return forMember(ctx, member.id, async () => {
    const number = await ctx.kv.get<number>(activeKey(member.id));
    await ctx.server.unban(member.id, reason);
    if (number) {
      const p = await ctx.kv.get<Expiry>(expiryKey(number));
      if (p) await retire(ctx, p, "lifted");
      else {
        await setStatus(ctx, number, "lifted");
        await ctx.kv.delete(activeKey(member.id));
      }
    }
    return recordCase(ctx, { action: "unban", member, moderator, reason, status: "lifted" });
  });
}
