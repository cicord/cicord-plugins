import type { ServerInvite } from "@cicord/sdk";
import type { InviteAttribution } from "./contracts.ts";

export type Snapshot = {
  uses: number;
  code: string;
  inviterId?: string;
  vanity?: boolean;
  maxUses?: number;
};
/**
 * Invite uses the counters showed but no join has been matched to yet. They happened after
 * `since` (the previous snapshot) and before `until` (the snapshot that showed them).
 * `attribution` is null when the uses cannot be told apart.
 */
export type Uses = {
  attribution: InviteAttribution | null;
  count: number;
  since: number;
  until: number;
};
export type Tracker = { invites: Map<string, Snapshot>; at: number; outstanding: Uses[] };

/** Tolerance between the host clock, Discord's join timestamps and counter updates. */
export const SKEW_MS = 15_000;

export function snapshot(inv: ServerInvite): Snapshot {
  return {
    uses: inv.uses ?? 0,
    code: inv.code,
    ...(inv.inviter ? { inviterId: inv.inviter.id } : {}),
    vanity: inv.vanity,
    ...(inv.maxUses ? { maxUses: inv.maxUses } : {}),
  };
}
export const baseline = (invites: Map<string, Snapshot>, at: number): Tracker => ({
  invites,
  at,
  outstanding: [],
});
const label = (s: Snapshot): InviteAttribution => ({
  code: s.vanity ? "vanity" : s.code,
  ...(s.inviterId ? { inviterId: s.inviterId } : {}),
});
// Discord deletes a capped invite when its last use is consumed: that join shows no delta.
const mayHaveBeenUsed = (s: Snapshot) => !!s.maxUses && s.uses < s.maxUses;

/** An invite deletion event. A capped invite may have just been used up by a join. */
export function forget(tracker: Tracker, code: string, at: number) {
  const prev = tracker.invites.get(code);
  if (!prev) return;
  tracker.invites.delete(code);
  if (mayHaveBeenUsed(prev))
    tracker.outstanding.push({ attribution: null, count: 1, since: tracker.at, until: at });
}

/**
 * Attributes one join from the counter evidence. A member is attributed only when every use
 * that could be theirs points at the same invite (or, failing that, the same inviter).
 * Discord gives no member identity with a use count, so two invites that both advance
 * between snapshots leave those joins unknown. Never a guess.
 */
export function attribute(
  tracker: Tracker,
  fresh: Map<string, Snapshot>,
  now: number,
  joinedAt: number,
): InviteAttribution {
  const since = tracker.at;
  for (const [code, entry] of fresh) {
    const prev = tracker.invites.get(code);
    if (!prev) {
      // Created while events were missed: its uses may be anyone's, at any time before now.
      if (entry.uses > 0)
        tracker.outstanding.push({
          attribution: null,
          count: entry.uses,
          since: -Infinity,
          until: now,
        });
      continue;
    }
    const diff = entry.uses - prev.uses;
    if (diff > 0)
      tracker.outstanding.push({ attribution: label(entry), count: diff, since, until: now });
  }
  for (const [code, prev] of tracker.invites)
    if (!fresh.has(code) && mayHaveBeenUsed(prev))
      tracker.outstanding.push({ attribution: null, count: 1, since, until: now });
  tracker.invites = fresh;
  tracker.at = now;
  // A snapshot taken before this member joined cannot contain their use, nor that of anyone
  // who joins later: those uses belong to joins that were missed.
  tracker.outstanding = tracker.outstanding.filter((u) => joinedAt <= u.until + SKEW_MS);
  // Uses that happened after this member joined are not theirs either.
  const candidates = tracker.outstanding.filter((u) => joinedAt > u.since - SKEW_MS);
  if (!candidates.length) return {};
  const first = candidates[0]!.attribution;
  if (
    first &&
    candidates.every(
      (u) => u.attribution?.code === first.code && u.attribution?.inviterId === first.inviterId,
    )
  ) {
    const oldest = candidates.reduce((a, b) => (b.until < a.until ? b : a));
    if (--oldest.count === 0) tracker.outstanding.splice(tracker.outstanding.indexOf(oldest), 1);
    return first;
  }
  // Different codes of a single inviter still identify the inviter, not the code.
  const inviter = first?.inviterId;
  const result: InviteAttribution =
    inviter && candidates.every((u) => u.attribution?.inviterId === inviter)
      ? { inviterId: inviter }
      : {};
  // This join consumed one of these uses, and nobody can tell which: the rest merge.
  const count = candidates.reduce((n, u) => n + u.count, 0) - 1;
  tracker.outstanding = tracker.outstanding.filter((u) => !candidates.includes(u));
  if (count > 0)
    tracker.outstanding.push({
      attribution: result.inviterId ? result : null,
      count,
      since: Math.min(...candidates.map((u) => u.since)),
      until: Math.max(...candidates.map((u) => u.until)),
    });
  return result;
}
