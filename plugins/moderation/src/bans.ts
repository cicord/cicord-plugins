import type { Context, Json } from "@cicord/sdk";
import { recordCase, saveNewCase, type Case } from "./moderation.ts";

type Person = NonNullable<Case["member"]>;
type Expiry = {
  sanction: Case;
  taskId?: string;
  release?: Case;
};

const pending = new Map<string, Promise<void>>();

/** Serialize Discord and KV changes for one member across concurrent commands and tasks. */
async function forMember<T>(user: string, work: () => Promise<T>): Promise<T> {
  const previous = pending.get(user) ?? Promise.resolve();
  let unlock!: () => void;
  const gate = new Promise<void>((resolve) => {
    unlock = resolve;
  });
  const tail = previous.then(() => gate);
  pending.set(user, tail);
  await previous;
  try {
    return await work();
  } finally {
    unlock();
    if (pending.get(user) === tail) pending.delete(user);
  }
}
const activeKey = (user: string) => `active-ban:${user}`;
const expiryKey = (number: number) => `ban-expiry:${number}`;
const marker = (number: number) => `[cicord tempban #${number}] `;

async function setStatus(ctx: Context, number: number, status: Case["status"]) {
  const c = await ctx.kv.get<Case>(`case:${number}`);
  if (c) await ctx.kv.set(`case:${number}`, { ...c, status } as unknown as Json);
}

async function retire(ctx: Context, number: number, status: "lifted" | "superseded") {
  await setStatus(ctx, number, status);
  const pendingExpiry = await ctx.kv.get<Expiry>(expiryKey(number));
  if (pendingExpiry?.taskId) await ctx.schedule.cancel(pendingExpiry.taskId);
  await ctx.kv.delete(expiryKey(number));
}

export async function applyBan(
  ctx: Context,
  member: Person,
  moderator: Case["moderator"],
  reason: string,
  deleteMessages: boolean,
  minutes?: number,
) {
  return forMember(member.id, async () => {
    const previous = await ctx.kv.get<number>(activeKey(member.id));
    const number = await ctx.kv.increment("cases");
    const at = new Date();
    const c: Case = {
      number,
      at: at.toISOString(),
      action: minutes ? "tempban" : "ban",
      member,
      moderator,
      reason,
      status: "active",
      source: { type: moderator ? "command" : "escalation" },
      ...(minutes
        ? { durationMinutes: minutes, expiresAt: new Date(+at + minutes * 60000).toISOString() }
        : {}),
    };
    if (minutes) {
      // Persist the intent and its expiry before applying the external effect. A replay
      // can identify a ban that succeeded immediately before the runtime stopped.
      const pendingExpiry: Expiry = { sanction: c };
      await ctx.kv.set(expiryKey(number), pendingExpiry as unknown as Json);
      const task = await ctx.schedule.after(minutes * 60000, "expireBan", {
        number,
        user: member.id,
      });
      pendingExpiry.taskId = task.id;
      await ctx.kv.set(expiryKey(number), pendingExpiry as unknown as Json);
    }
    const auditReason =
      (minutes ? marker(number) : "") +
      `${moderator?.name ?? "automatic"}: ${reason || "no reason"}`;
    await ctx.server.ban(member.id, {
      reason: Array.from(auditReason).slice(0, 512).join(""),
      ...(deleteMessages ? { deleteMessagesSeconds: 86400 } : {}),
    });
    await ctx.kv.set(activeKey(member.id), number);
    await saveNewCase(ctx, c);
    if (previous && previous !== number) await retire(ctx, previous, "superseded");
    return c;
  });
}

/** Check the exact Discord ban as well as the local case before releasing it.
 * Paging just before the target gives at most one record, even on a large server. */
async function currentBan(ctx: Context, user: string) {
  const [entry] = await ctx.server.bans({ after: String(BigInt(user) - 1n), limit: 1 });
  return entry?.user.id === user ? entry : undefined;
}

export async function expireBan(ctx: Context, number: number, user: string) {
  await forMember(user, async () => {
    const pendingExpiry = await ctx.kv.get<Expiry>(expiryKey(number));
    if (!pendingExpiry || pendingExpiry.sanction.member?.id !== user) return;
    const active = await ctx.kv.get<number>(activeKey(user));
    const remote = await currentBan(ctx, user);
    const ours = remote?.reason?.startsWith(marker(number));
    if ((active !== undefined && active > number) || (remote && !ours)) {
      await retire(ctx, number, "superseded");
      return;
    }
    if (!remote && !pendingExpiry.release) {
      await setStatus(ctx, number, "lifted");
      if (active === number) await ctx.kv.delete(activeKey(user));
      await ctx.kv.delete(expiryKey(number));
      return;
    }
    // Reserve the resolution's case number before unbanning. If acknowledgement is
    // lost, saveNewCase reuses this number and cannot append a second resolution.
    if (!pendingExpiry.release) {
      pendingExpiry.release = {
        number: await ctx.kv.increment("cases"),
        action: "unban",
        at: new Date().toISOString(),
        member: pendingExpiry.sanction.member,
        moderator: null,
        reason: `Temporary ban #${number} expired`,
        status: "lifted",
        source: { type: "escalation" },
      };
      await ctx.kv.set(expiryKey(number), pendingExpiry as unknown as Json);
    }
    if (remote) await ctx.server.unban(user, pendingExpiry.release.reason);
    await saveNewCase(ctx, pendingExpiry.sanction);
    await setStatus(ctx, number, "expired");
    await saveNewCase(ctx, pendingExpiry.release);
    if (active === number) await ctx.kv.delete(activeKey(user));
    await ctx.kv.delete(expiryKey(number));
  });
}

export async function liftBan(ctx: Context, member: Person, moderator: Person, reason: string) {
  return forMember(member.id, async () => {
    const number = await ctx.kv.get<number>(activeKey(member.id));
    await ctx.server.unban(member.id, reason);
    if (number) {
      await retire(ctx, number, "lifted");
      await ctx.kv.delete(activeKey(member.id));
    }
    return recordCase(ctx, { action: "unban", member, moderator, reason, status: "lifted" });
  });
}
