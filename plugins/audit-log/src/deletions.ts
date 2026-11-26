import type { AuditLogEntry, Context, Message, TextChannel } from "@cicord/sdk";
import { DAY, esc, feature, ignored, record, tr } from "./log.ts";

type Cached = { author: string; authorName: string; channel: string; at: number; content?: string };
type Pending = {
  id: string;
  channel: string;
  at: number;
  author: string;
  authorName: string;
  content?: string;
  contentUntil?: number;
};
type Proof = {
  id: string;
  actor: string;
  name: string;
  author: string;
  channel: string;
  at: number;
  received: number;
  count: number;
  used: number;
  message?: string;
};
const span = 30_000;
const base = (c: string, a: string) => c + ":" + a + ":";
const pendingKey = (p: Pending) => "pending:" + base(p.channel, p.author) + p.id;
const proofKey = (p: Proof) => "proof:" + base(p.channel, p.author) + p.id;

export async function remember(ctx: Context, m: Message) {
  if (
    !ctx.config.enabled ||
    !ctx.config.events.messageDeletes ||
    !m.author?.id ||
    ignored(ctx, m.channel.id)
  )
    return;
  const take = ctx.config.cacheContent && feature(ctx, "cacheContent") && !m.author.bot;
  const observed = Math.min(Date.now(), m.createdAt?.getTime() ?? Date.now());
  const ttl =
    (observed + Math.min(take ? 7 : 1, ctx.config.retentionDays) * DAY - Date.now()) / 1000;
  if (!(ttl > 0)) return;
  const v: Cached = {
    author: m.author.id,
    authorName: m.author.username,
    channel: m.channel.id,
    at: observed,
    ...(take && m.content ? { content: m.content.slice(0, 2000) } : {}),
  };
  if (ctx.config.ignoreBots && m.author.bot) {
    await ctx.kv.set("bot-message:" + m.id, true, {
      ttlSeconds: Math.min(7, ctx.config.retentionDays) * 86400,
    });
    return;
  }
  await ctx.kv.set("seen:" + m.id, v, {
    ttlSeconds: ttl,
  });
}

async function report(ctx: Context, p: Pending, proof?: Proof, exact = false) {
  const certainty = proof ? (proof.count > 1 ? "probable" : "confirmed") : "unknown";
  const who = proof ? esc(proof.name || proof.actor) + " (<@" + proof.actor + ">)" : "";
  // Discord's ordinary audit record identifies an author and channel, never
  // the message itself. Keep the confirmed observation at that granularity.
  const key = proof
    ? exact
      ? "delete.exact"
      : certainty === "probable"
        ? "delete.merged"
        : "delete.single"
    : "delete.unknown";
  const owner = p.author ? "<@" + p.author + ">" : tr(ctx, "unavailable");
  await record(
    ctx,
    {
      group: "messages",
      category: "messageDeletes",
      subjects: [p.author, ...(proof ? [proof.actor] : [])],
      sources: [p.channel],
      text: tr(ctx, key, {
        who,
        author: owner,
        channel: "<#" + p.channel + ">",
        count: proof?.count ?? 0,
      }),
      ...(p.content && p.contentUntil && p.contentUntil > Date.now()
        ? { excerpt: p.content, contentUntil: p.contentUntil }
        : {}),
    },
    "delete-" + p.id,
    true,
  );
  await ctx.kv.delete(pendingKey(p));
}

// Reserve a unit of evidence and persist its association before sending.
// Concurrent deliveries can neither consume a counter twice nor lose a result.
async function correlate(ctx: Context, channel: string, author: string) {
  if (!author) return;
  const pending = (
    await ctx.kv.list<Pending>({ prefix: "pending:" + base(channel, author), limit: 12 })
  ).items;
  const proofs = (await ctx.kv.list<Proof>({ prefix: "proof:" + base(channel, author), limit: 12 }))
    .items;
  if (pending.length === 12 || proofs.length === 12) return;
  for (const { value: p } of pending) {
    const claimed = await ctx.kv.get<Proof>("matched:" + p.id);
    if (claimed) {
      await report(ctx, p, claimed, claimed.message === p.id);
      continue;
    }
    const matches = proofs.filter(
      ({ value: e }) =>
        e.used < e.count &&
        Math.abs(p.at - e.received) <= span &&
        (!e.message || e.message === p.id),
    );
    const explicit = matches.filter((x) => x.value.message === p.id);
    const candidates = explicit.length ? explicit : matches;
    if (candidates.length !== 1) continue;
    const { key } = candidates[0]!,
      entry = await ctx.kv.getEntry<Proof>(key);
    if (!entry || entry.value.count <= entry.value.used) continue;
    const e = entry.value;
    if (!e.message && pending.filter((x) => Math.abs(x.value.at - e.received) <= span).length !== 1)
      continue;
    const tx = ctx.kv
      .atomic()
      .check(key, entry.version)
      .check("matched:" + p.id, undefined)
      .set(key, { ...e, used: e.used + 1 }, { ttlSeconds: 90 })
      .set("matched:" + p.id, e, { ttlSeconds: 90 });
    if ((await tx.commit()).ok) await report(ctx, p, e, !!e.message);
  }
}
export async function deletion(ctx: Context, id: string, channel: TextChannel) {
  if (
    !ctx.config.enabled ||
    !ctx.config.events.messageDeletes ||
    ignored(ctx, channel.id) ||
    (await ctx.kv.get("bot-message:" + id))
  )
    return;
  if (await ctx.kv.get("row:delete-" + id)) return;
  const cached = await ctx.kv.get<Cached>("seen:" + id);
  const c = cached?.channel === channel.id ? cached : undefined;
  const p: Pending = {
    id,
    at: Date.now(),
    channel: channel.id,
    author: c?.author ?? "",
    authorName: c?.authorName ?? "",
    ...(c?.content && ctx.config.cacheContent && feature(ctx, "cacheContent")
      ? { content: c.content, contentUntil: c.at + Math.min(7, ctx.config.retentionDays) * DAY }
      : {}),
  };
  const tx = ctx.kv
    .atomic()
    .check(pendingKey(p), undefined)
    .set(pendingKey(p), p, { ttlSeconds: Math.min(7, ctx.config.retentionDays) * 86400 });
  if (!(await tx.commit()).ok) return;
  // The task contains a reference only. Missing registration is recovered by sweep.
  await ctx.schedule.after(span, "deletionDeadline", { key: pendingKey(p) });
  if (p.author) await ctx.schedule.after(3000, "probeDeletion", { key: pendingKey(p), attempt: 1 });
  await correlate(ctx, channel.id, p.author);
}
export async function deadline(ctx: Context, key: string) {
  const p = await ctx.kv.get<Pending>(key);
  if (!p) return;
  const remaining = p.at + span - Date.now();
  if (remaining > 0) {
    await ctx.schedule.after(remaining, "deletionDeadline", { key });
    return;
  }
  if (ctx.config.enabled) {
    const proof = await ctx.kv.get<Proof>("matched:" + p.id);
    await report(ctx, p, proof, proof?.message === p.id);
  }
}
export async function observeProof(ctx: Context, e: AuditLogEntry, reconcile = true) {
  if (
    !ctx.config.events.messageDeletes ||
    e.action !== "message.delete" ||
    !e.actorId ||
    !e.targetId
  )
    return;
  const channel = e.options?.channel_id;
  if (typeof channel !== "string" || ignored(ctx, channel)) return;
  const count = Number(e.options?.count ?? 1);
  if (!Number.isSafeInteger(count) || count < 1) return;
  const message = e.options?.message_id;
  const old = await ctx.kv.getEntry<Proof>("proof:" + base(channel, e.targetId) + e.id);
  if (old && count < old.value.count) return;
  if (!old && Math.abs(Date.now() - e.at.getTime()) > span) return;
  if (!old || count !== old.value.count) {
    const p: Proof = {
      id: e.id,
      actor: e.actorId,
      name: e.actor?.username ?? "",
      author: e.targetId,
      channel,
      at: e.at.getTime(),
      received: Date.now(),
      count,
      // The first sight of a coalesced count only proves one currently observed aggregate.
      used: old?.value.used ?? Math.max(0, count - 1),
      ...(typeof message === "string" ? { message } : {}),
    };
    const changed = await ctx.kv
      .atomic()
      .check(proofKey(p), old?.version)
      .set(proofKey(p), p, { ttlSeconds: 90 })
      .commit();
    if (!changed.ok) return;
  }
  if (reconcile) await correlate(ctx, channel, e.targetId);
  const saved = await ctx.kv.get<Proof>("proof:" + base(channel, e.targetId) + e.id);
  if (saved && saved.used < saved.count)
    await ctx.schedule.after(1500, "auditFact", { proof: proofKey(saved), count: saved.count });
}

export async function auditFact(ctx: Context, key: string, count: number) {
  const p = await ctx.kv.get<Proof>(key);
  if (!ctx.config.enabled || !p || p.count !== count || p.used >= count) return;
  const who = esc(p.name || p.actor) + " (<@" + p.actor + ">)";
  await record(
    ctx,
    {
      group: "messages",
      category: "messageDeletes",
      subjects: [p.author, p.actor],
      sources: [p.channel],
      text: tr(ctx, p.count === 1 ? "delete.single" : "delete.merged", {
        who,
        author: "<@" + p.author + ">",
        channel: "<#" + p.channel + ">",
        count,
      }),
    },
    "fact-" + p.id + "-" + count,
    true,
  );
}

// Discord can update an existing deletion count without a second gateway CREATE.
// Stage all matching REST rows before correlation so list order cannot pick a winner.
export async function probeDeletion(ctx: Context, key: string, attempt: number) {
  const p = await ctx.kv.get<Pending>(key);
  if (!ctx.config.enabled || !p || !p.author || Date.now() - p.at >= span) return;
  const rows = await ctx.server.auditLog({ action: "message.delete", limit: 50 });
  for (const e of rows)
    if (e.targetId === p.author && e.options?.channel_id === p.channel)
      await observeProof(ctx, e, false);
  await correlate(ctx, p.channel, p.author);
  if (attempt < 3 && (await ctx.kv.get(key)))
    await ctx.schedule.after(attempt === 1 ? 5000 : 10000, "probeDeletion", {
      key,
      attempt: attempt + 1,
    });
}
