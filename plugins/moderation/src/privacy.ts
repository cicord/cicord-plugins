import type { Context, Json } from "@cicord/sdk";
import { type Case, caseTTL, redactCaseDelivery, warnPrefix } from "./moderation.ts";
import { preserveBanTasksForErasure } from "./bans.ts";
import { preserveQuarantineForErasure } from "./quarantine.ts";
import { memberCase } from "./cases.ts";
import { eraseActivity } from "./activity.ts";
import type { Appeal } from "./appeals.ts";

async function pages<T extends Json>(
  ctx: Context,
  prefix: string,
  each: (k: string, v: T) => Promise<void>,
) {
  let cursor: string | undefined;
  do {
    const p = await ctx.kv.list<T>({ prefix, limit: 100, cursor });
    for (const row of p.items) await each(row.key, row.value);
    cursor = p.cursor;
  } while (cursor);
}
type PendingCopy = { number: number; revoke: boolean };
async function finishCopyErasure(ctx: Context, k: string, copy: PendingCopy) {
  await redactCaseDelivery(ctx, copy.number);
  if (copy.revoke && ctx.features.enabled("appeals"))
    await ctx.portal.revoke({ kind: "case", id: String(copy.number) });
  await ctx.kv.delete(k);
}

async function redactCase(ctx: Context, k: string, user: string, deleted: string, prefix: string) {
  for (let retry = 0; retry < 8; retry++) {
    const entry = await ctx.kv.getEntry<Case>(k);
    if (!entry) return 0;
    const c = entry.value,
      subject = c.member?.id === user;
    if (!subject && c.moderator?.id !== user) return 0;
    const receipt = prefix + c.number,
      copy = { number: c.number, revoke: subject };
    // The receipt contains a pseudonym and an opaque case number. If Discord
    // refuses the withdrawal after the user index has gone, the next request
    // still finds it and cannot report completion until withdrawal succeeds.
    const tx = ctx.kv.atomic().check(k, entry.version).set(receipt, copy);
    const ttlSeconds = caseTTL(c.at);
    if (!ttlSeconds || c.action === "note") tx.delete(k);
    else {
      const removed = { id: deleted, name: "Deleted user" };
      c.reason = "";
      delete c.evidence;
      delete c.evidenceChannelId;
      if (subject) c.member = removed;
      if (c.moderator?.id === user) c.moderator = removed;
      tx.set(k, c, { ttlSeconds });
    }
    if (!(await tx.commit()).ok) continue;
    await finishCopyErasure(ctx, receipt, copy);
    return 1;
  }
  throw new Error("The case changed during erasure; retry the privacy request.");
}
export const privacy = {
  async export(ctx: Context, user: string) {
    const cases: Json[] = [],
      appeals: Json[] = [];
    await pages<Case>(ctx, "case:", async (_, c) => {
      if (c.member?.id === user && c.action !== "note") cases.push(memberCase(c));
    });
    await pages<Appeal>(ctx, "appeal:", async (_, a) => {
      if (a.userId === user) appeals.push({ case: a.case, text: a.text, status: a.status });
    });
    return { cases, appeals, quarantined: !!(await ctx.kv.get("quarantine:" + user)) };
  },
  async erase(ctx: Context, user: string) {
    let erased = 0;
    const deleted = await ctx.privacy.pseudonym(user);
    await preserveBanTasksForErasure(ctx, user, deleted);
    await preserveQuarantineForErasure(ctx, user, deleted);
    erased += await eraseActivity(ctx, user);
    const prefix = "privacy-copy:" + deleted + ":";
    await pages<PendingCopy>(ctx, prefix, async (k, copy) => {
      await finishCopyErasure(ctx, k, copy);
      erased++;
    });
    await pages<Case>(ctx, "case:", async (k, c) => {
      if (c.member?.id === user || c.moderator?.id === user)
        erased += await redactCase(ctx, k, user, deleted, prefix);
    });
    await pages<Appeal>(ctx, "appeal:", async (k, a) => {
      if (a.userId === user) {
        await ctx.kv.delete(k);
        erased++;
      } else if (a.by === user) {
        delete a.by;
        await ctx.kv.set(k, a);
        erased++;
      }
    });
    // Warnings on another member can still name this person as moderator.
    await pages<{
      case: number;
      at: string;
      reason: string;
      moderator: string | null;
      evidence?: string;
    }>(ctx, "warn:", async (k, w) => {
      if (w.moderator !== user || k.startsWith(warnPrefix(user))) return;
      const seconds = Math.ceil(
        (Date.parse(w.at) + ctx.config.warningDays * 86400000 - Date.now()) / 1000,
      );
      if (seconds <= 0) await ctx.kv.delete(k);
      else
        await ctx.kv.set(
          k,
          { case: w.case, at: w.at, reason: "", moderator: deleted },
          { ttlSeconds: seconds },
        );
      erased++;
    });
    // An unacknowledged sanction may still have a full case in its recovery record.
    // Keep Discord evidence and the original subject id required for proof, sanitize
    // only person-facing fields, and use a version check against a concurrent expiry.
    await pages<{ sanction: Case; release?: Case }>(ctx, "ban-expiry:", async (k) => {
      for (let retry = 0; retry < 8; retry++) {
        const row = await ctx.kv.getEntry<{ sanction: Case; release?: Case }>(k);
        if (!row) return;
        const record = row.value;
        let changed = false;
        for (const c of [record.sanction, record.release]) {
          if (!c || (c.member?.id !== user && c.moderator?.id !== user)) continue;
          changed = true;
          c.reason = "";
          delete c.evidence;
          delete c.evidenceChannelId;
          if (c.member?.id === user) c.member = { id: user, name: "Deleted user" };
          if (c.moderator?.id === user) c.moderator = { id: deleted, name: "Deleted user" };
        }
        if (!changed) return;
        if ((await ctx.kv.atomic().check(k, row.version).set(k, record).commit()).ok) {
          erased++;
          return;
        }
      }
      throw new Error("The ban changed during erasure; retry the privacy request.");
    });
    for (const prefix of [warnPrefix(user), "case-user:" + user + ":"])
      await pages(ctx, prefix, async (k) => {
        await ctx.kv.delete(k);
        erased++;
      });
    await ctx.kv
      .atomic()
      .delete("moderator-total:" + user)
      .rankRemove("moderators", user)
      .commit();
    return { erased };
  },
};
