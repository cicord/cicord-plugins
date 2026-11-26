import type { Context, Json } from "@cicord/sdk";
import { type Case, warnPrefix } from "./moderation.ts";
import { memberCase } from "./cases.ts";
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
    await pages<Case>(ctx, "case:", async (k, c) => {
      if (c.member?.id !== user && c.moderator?.id !== user) return;
      if (c.action === "note") {
        await ctx.kv.delete(k);
        erased++;
        return;
      }
      const activeBan =
        c.member?.id === user && (await ctx.kv.get<number>("active-ban:" + user)) === c.number;
      const q = await ctx.kv.get<{ number: number }>("quarantine:" + user);
      // Keep a live sanction's minimal target so it can still be released safely.
      const keepTarget = activeBan || q?.number === c.number;
      const remaining = Math.ceil((Date.parse(c.at) + 365 * 86400000 - Date.now()) / 1000);
      if (remaining <= 0 && !keepTarget) {
        await ctx.kv.delete(k);
      } else {
        const tombstone = { id: deleted, name: "Deleted user" };
        c.reason = "";
        delete c.evidence;
        delete c.evidenceChannelId;
        if (c.member?.id === user)
          c.member = keepTarget ? { id: user, name: "Deleted user" } : tombstone;
        if (c.moderator?.id === user) c.moderator = tombstone;
        await ctx.kv.set(k, c, keepTarget ? {} : { ttlSeconds: remaining });
      }
      if (ctx.features.enabled("appeals"))
        await ctx.portal.revoke({ kind: "case", id: String(c.number) });
      erased++;
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
