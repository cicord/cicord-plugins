import type { Context, KVAtomic } from "@cicord/sdk";
import type { InviteAttribution, InviteCounts } from "./contracts.ts";
export type Entry = InviteAttribution & { at: number; fake: boolean; left: boolean; indexed?: 1 };
type Migration = { cursor: string; processed: number; ready: boolean };
const progressKey = "index:v1:progress",
  rank = "invites-valid";
const PAGE = 16;
const blank = (): InviteCounts => ({ valid: 0, fake: 0, left: 0 });
type Change = { id: string; apply: (entry: Entry | undefined) => Entry | undefined };
function contribute(deltas: Map<string, InviteCounts>, entry: Entry | undefined, sign: number) {
  if (!entry?.inviterId) return;
  const delta = deltas.get(entry.inviterId) ?? blank();
  if (entry.fake) delta.fake += sign;
  else if (!entry.left) delta.valid += sign;
  if (entry.left) delta.left += sign;
  deltas.set(entry.inviterId, delta);
}
// Use the source version, not the value previously observed on a list page.
// Aggregate changes and source stamps commit together, including during migration.
async function stage(ctx: Context, tx: KVAtomic, changes: Change[]) {
  const deltas = new Map<string, InviteCounts>();
  for (const { id, apply } of changes) {
    const key = "member:" + id,
      source = await ctx.kv.getEntry<Entry>(key),
      old = source?.value,
      next = apply(old);
    tx.check(key, source?.version);
    if (old === next && (!old || old.indexed === 1)) continue;
    if (old?.indexed === 1) contribute(deltas, old, -1);
    contribute(deltas, next, 1);
    if (old?.indexed && old.inviterId && old.inviterId !== next?.inviterId)
      tx.delete("by:" + old.inviterId + ":" + id);
    if (next) {
      tx.set(key, { ...next, indexed: 1 });
      if (next.inviterId && (!old?.indexed || next.inviterId !== old.inviterId))
        tx.set("by:" + next.inviterId + ":" + id, true);
    } else tx.delete(key);
  }
  for (const [uid, delta] of deltas) {
    const key = "count:" + uid,
      previous = await ctx.kv.getEntry<InviteCounts>(key),
      old = previous?.value ?? blank();
    tx.check(key, previous?.version);
    const next = {
      valid: old.valid + delta.valid,
      left: old.left + delta.left,
      fake: old.fake + delta.fake,
    };
    if (Math.min(next.valid, next.left, next.fake) < 0)
      throw new Error("Invite index needs repair");
    if (next.valid || next.left || next.fake) tx.set(key, next).rankSet(rank, uid, next.valid);
    else tx.delete(key).rankRemove(rank, uid);
  }
}
export async function changeMember(ctx: Context, id: string, apply: Change["apply"]) {
  for (let retry = 0; retry < 8; retry++) {
    const tx = ctx.kv.atomic();
    await stage(ctx, tx, [{ id, apply }]);
    if ((await tx.commit()).ok) return;
  }
  throw new Error("Concurrent changes to invite records; retry");
}
export async function progress(ctx: Context) {
  return ctx.kv.get<Migration>(progressKey);
}
export async function initializeIndex(ctx: Context) {
  const state = await ctx.kv.getEntry<Migration>(progressKey);
  if (state?.value.ready) return;
  if (!state && !(await ctx.kv.list({ prefix: "member:", limit: 1 })).items.length) {
    if (
      (
        await ctx.kv
          .atomic()
          .check(progressKey, undefined)
          .set(progressKey, { ready: true, cursor: "", processed: 0 })
          .commit()
      ).ok
    )
      return;
  }
  await ctx.schedule.after(1, "migrate");
}
export async function migrate(ctx: Context) {
  const mark = await ctx.kv.getEntry<Migration>(progressKey);
  if (mark?.value.ready) return;
  const page = await ctx.kv.list<Entry>({
    prefix: "member:",
    cursor: mark?.value.cursor || undefined,
    limit: PAGE,
  });
  const tx = ctx.kv.atomic().check(progressKey, mark?.version);
  await stage(
    ctx,
    tx,
    page.items.map((item) => ({ id: item.key.slice(7), apply: (prior) => prior })),
  );
  const next: Migration = {
    cursor: page.cursor ?? "",
    processed: (mark?.value.processed ?? 0) + page.items.length,
    ready: !page.cursor,
  };
  tx.set(progressKey, next);
  // The running durable job owns the handoff. A lost acknowledgement replays
  // from the committed cursor. A duplicate worker that loses the cursor race exits.
  if (!(await tx.commit()).ok) {
    if ((await ctx.kv.getEntry(progressKey))?.version !== mark?.version) return;
    throw new Error("Invite sources changed during indexing; retry this page");
  }
  if (page.cursor) await ctx.schedule.after(1, "migrate");
}
export async function count(ctx: Context, id: string) {
  const status = await progress(ctx);
  if (!status?.ready) throw new Error(ctx.i18n.t("indexing", { n: status?.processed ?? 0 }));
  return (await ctx.kv.get<InviteCounts>("count:" + id)) ?? blank();
}
export async function ranking(ctx: Context, limit: number, offset = 0) {
  const status = await progress(ctx);
  if (!status?.ready) throw new Error(ctx.i18n.t("indexing", { n: status?.processed ?? 0 }));
  const top = await ctx.kv.ranking(rank).top({ limit, offset });
  const counts = await ctx.kv.getMany<InviteCounts>(top.map((r) => "count:" + r.member));
  return top.flatMap((r, i) => (counts[i] ? [{ userId: r.member, ...counts[i]! }] : []));
}
// Reference traversal is proportional to this member's own invitations once the
// index is complete. Legacy references still participate in erasure during backfill.
export async function related(ctx: Context, id: string) {
  const out = new Set<string>([id]),
    ready = (await progress(ctx))?.ready;
  let cursor: string | undefined;
  do {
    const prefix = ready ? "by:" + id + ":" : "member:",
      page = await ctx.kv.list<Entry | boolean>({ prefix, cursor, limit: 1000 });
    for (const { key, value } of page.items)
      if (ready || (typeof value === "object" && value.inviterId === id))
        out.add(key.slice(prefix.length));
    cursor = page.cursor;
  } while (cursor);
  return out;
}
