import type { Context, Json, Member, MessagePayload, TextChannel } from "@cicord/sdk";

export type Group = "members" | "messages" | "plugins" | "structure" | "security" | "voice";
export type Observation = {
  group: Group;
  category: string;
  text: string;
  subjects: string[];
  sources: string[];
  excerpt?: string;
  contentUntil?: number;
};
export type Row = Observation & {
  id: string;
  at: number;
  until: number;
  destination: string;
  copy?: string;
  erasing?: boolean;
};
type Plan = {
  channel: string;
  ids: string[];
  dropped: number;
  started?: number;
  before?: string;
  message?: string;
};
export const DAY = 86_400_000;
const PAD = (at: number) => String(at).padStart(15, "0");
const qkey = (r: Row) => "queue:" + PAD(r.at) + ":" + r.id;
const expiryKey = (r: Row) => "expiry:" + PAD(r.until) + ":" + r.id;
const leaseSeconds = 60;
export const esc = (v: string) => v.replace(/([\\*_`~|>[\]()])/g, "\\$1").slice(0, 300);
export const snowflakeTime = (id: string) => Math.floor(Number(id) / 4_194_304) + 1_420_070_400_000;
export const ts = (at: number, style = "R") => `<t:${Math.floor(at / 1000)}:${style}>`;
export function feature(ctx: Context, name: string): boolean {
  return ctx.features.enabled(name);
}
export function tr(ctx: Context, key: string, vars: Record<string, string | number> = {}): string {
  return ctx.i18n.t(key, vars);
}
export function ignored(ctx: Context, id: string): boolean {
  return ctx.config.ignoredChannels.some((ref) => {
    try {
      return ref === id || ctx.server.channel(ref).id === id;
    } catch {
      return ref === id;
    }
  });
}
export function staffDestination(ctx: Context, group: Group): TextChannel | undefined {
  const baseKey = ctx.config.channel;
  if (!baseKey) return;
  try {
    const base = ctx.server.channel(baseKey),
      dest = ctx.server.channel(ctx.config.channels?.[group] ?? baseKey);
    const policy = ctx.server.audience(base),
      other = ctx.server.audience(dest);
    if (!policy.known || policy.public || !other.known || other.public) return;
    const relation = ctx.server.compareAudience(base, dest);
    if (relation === "same" || relation === "narrower") return dest;
  } catch {
    /* unresolved or incomplete guild cache */
  }
}
function destination(ctx: Context, group: Group) {
  const dest = staffDestination(ctx, group);
  ctx.status.set(
    "audience." + group,
    dest
      ? null
      : "A known private staff log with an equal or narrower destination audience is required.",
  );
  return dest;
}
export function visible(ctx: Context, row: Row, member: Member): boolean {
  try {
    const dest = staffDestination(ctx, row.group);
    return (
      !!dest &&
      row.destination === dest.id &&
      !row.erasing &&
      row.until > Date.now() &&
      member.canView(dest) &&
      row.sources.every((s) => member.canView(ctx.server.channel({ id: s })))
    );
  } catch {
    return false;
  }
}
function searchIndex(ctx: Context) {
  return ctx.index("observations");
}
async function indexRow(ctx: Context, r: Row) {
  if (!feature(ctx, "search")) return;
  await ctx.kv.set("indexed:" + r.id, true);
  try {
    await searchIndex(ctx).upsert(r.id, {
      title: "observation " + r.category,
      text: [r.text, r.excerpt ?? ""].join(" "),
      tags: [r.category, ...r.subjects.map((id) => "member-" + id)],
      meta: null,
    });
    ctx.status.set("index", null);
  } catch {
    ctx.status.set(
      "index",
      "Search indexing failed. Metadata remains available through paginated export.",
    );
  }
}
export async function record(ctx: Context, value: Observation, origin?: string, urgent = false) {
  if (!ctx.config.enabled) return;
  const dest = destination(ctx, value.group);
  if (!dest) return;
  const id = origin ?? crypto.randomUUID(),
    at = Date.now();
  const previous = await ctx.kv.get<Row>("row:" + id);
  if (previous) {
    if (previous.erasing) return;
    await indexRow(ctx, previous);
    if (urgent || ctx.config.batchSeconds === 0)
      await reserve(ctx, [{ key: qkey(previous), value: previous.id }], 0);
    return;
  }
  const until = Math.min(at + ctx.config.retentionDays * DAY, value.contentUntil ?? Infinity);
  if (until <= at) return;
  const r: Row = {
    ...value,
    text: value.text.slice(0, 520),
    subjects: [
      ...new Set(
        [
          ...value.subjects,
          ...Array.from(
            ((value.excerpt ?? "") + " " + value.text).matchAll(/<@!?(\d{1,20})>/g),
            (m) => m[1]!,
          ),
        ].filter(Boolean),
      ),
    ],
    sources: [...new Set(value.sources.filter(Boolean))],
    id,
    at,
    until,
    destination: dest.id,
  };
  const tx = ctx.kv
    .atomic()
    .check("row:" + id, undefined)
    .set("row:" + id, r)
    .set(qkey(r), id)
    .set(expiryKey(r), id);
  if (!(await tx.commit()).ok) return;
  await indexRow(ctx, r);
  if (urgent || ctx.config.batchSeconds === 0) {
    await reserve(ctx, [{ key: qkey(r), value: r.id }], 0);
    return;
  }
  const timer = await ctx.kv
    .atomic()
    .check("flush:timer", undefined)
    .set("flush:timer", true, { ttlSeconds: Math.max(2, ctx.config.batchSeconds + 1) })
    .commit();
  if (timer.ok) await ctx.schedule.after(ctx.config.batchSeconds * 1000, "flush");
}

function payload(ctx: Context, rows: Row[], id: string, dropped: number): MessagePayload {
  // An immutable Discord copy cannot check another channel's future membership.
  // Inline excerpts only inside the source itself. Distinct log channels receive metadata.
  const lines = rows.map((r) => {
    const inline =
      r.excerpt &&
      r.contentUntil &&
      r.contentUntil > Date.now() &&
      ctx.config.cacheContent &&
      feature(ctx, "cacheContent") &&
      r.sources.length === 1 &&
      r.sources[0] === r.destination;
    return (
      ts(r.at, "T") +
      " " +
      (r.text + (inline ? " · " + esc(r.excerpt!).slice(0, 200) : "")).slice(0, 570)
    );
  });
  if (dropped) lines.push(tr(ctx, "overflow", { count: dropped }));
  return {
    embeds: [
      {
        description: lines.join("\n").slice(0, 3800),
        footer: { text: "cicord/" + id },
        color: "#526878",
      },
    ],
    allowedMentions: { users: false, roles: false, everyone: false },
    nonce: id,
    enforceNonce: true,
  };
}
async function planRows(ctx: Context, plan: Plan): Promise<Row[]> {
  const rows = await ctx.kv.getMany<Row>(plan.ids.map((id) => "row:" + id));
  return rows.filter(
    (r): r is Row =>
      !!r && !r.erasing && r.until > Date.now() && destination(ctx, r.group)?.id === plan.channel,
  );
}
// A send may have succeeded before its receipt was committed. Walk history
// back to the first attempt before resending. Resume a busy channel one page per task.
async function deliver(ctx: Context, id: string) {
  let plan = await ctx.kv.get<Plan>("work:" + id);
  if (!plan) return;
  const lease = await ctx.kv
    .atomic()
    .check("work-lock:" + id, undefined)
    .set("work-lock:" + id, true, { ttlSeconds: leaseSeconds })
    .commit();
  if (!lease.ok) return;
  try {
    const channel = ctx.server.channel({ id: plan.channel });
    const rows = await planRows(ctx, plan);
    let message = plan.message;
    if (plan.started !== undefined && !message) {
      const page = await channel.messages({
        limit: 100,
        ...(plan.before ? { before: plan.before } : {}),
      });
      message = page.find(
        (m) =>
          m.author.id === ctx.bot.user.id &&
          m.embeds.some((e) => e.footer?.text === "cicord/" + id),
      )?.id;
      const last = page.at(-1);
      if (
        !message &&
        page.length === 100 &&
        last &&
        last.createdAt.getTime() >= plan.started - 60_000
      ) {
        await ctx.kv.set("work:" + id, { ...plan, before: last.id });
        await ctx.schedule.after(1000, "flush");
        return;
      }
    }
    if (rows.length && !message) {
      plan = { ...plan, started: Date.now() };
      delete plan.before;
      await ctx.kv.set("work:" + id, plan);
      message = (await channel.send(payload(ctx, rows, id, plan.dropped))).id;
    }
    const tx = ctx.kv.atomic().delete("work:" + id);
    if (message) tx.set("copy:" + id, { ...plan, message });
    await tx.commit();
  } finally {
    await ctx.kv.delete("work-lock:" + id);
  }
}

// Each persisted plan is one Discord message. Reservations and row → copy
// links commit together, so simultaneous flush deliveries cannot own the same rows.
async function reserve(ctx: Context, entries: { key: string; value: Json }[], dropped: number) {
  const rows = await ctx.kv.getMany<Row>(entries.map((i) => "row:" + String(i.value)));
  const groups = new Map<string, { row: Row; key: string }[]>();
  for (let i = 0; i < entries.length; i++) {
    const key = entries[i]!.key,
      r = rows[i];
    if (!r || r.erasing || r.until <= Date.now()) {
      await ctx.kv.delete(key);
      continue;
    }
    const list = groups.get(r.destination) ?? [];
    list.push({ row: r, key });
    groups.set(r.destination, list);
  }
  for (const [channel, items] of groups)
    for (let offset = 0; offset < items.length; offset += 6) {
      const chunk = items.slice(offset, offset + 6),
        id = crypto.randomUUID().replaceAll("-", "").slice(0, 24);
      const tx = ctx.kv.atomic();
      let valid = true;
      for (const item of chunk) {
        const q = await ctx.kv.getEntry(item.key),
          r = await ctx.kv.getEntry<Row>("row:" + item.row.id);
        if (!q || !r || r.value.erasing) {
          valid = false;
          break;
        }
        tx.check(item.key, q.version)
          .check("row:" + r.value.id, r.version)
          .delete(item.key)
          .set("row:" + r.value.id, { ...r.value, copy: id });
      }
      if (!valid) continue;
      tx.set("work:" + id, { channel, ids: chunk.map((i) => i.row.id), dropped });
      if ((await tx.commit()).ok) {
        dropped = 0;
        await deliver(ctx, id);
      }
    }
}
export async function flush(ctx: Context, stale = false) {
  if (!ctx.config.enabled) return;
  if (stale && (await ctx.kv.get("flush:timer"))) return;
  await ctx.kv.delete("flush:timer");
  const existing = await ctx.kv.list({ prefix: "work:", limit: 10 });
  for (const w of existing.items) await deliver(ctx, w.key.slice(5));
  const cap = ctx.config.maxPerBatch;
  const page = await ctx.kv.list({ prefix: "queue:", limit: Math.max(100, cap) });
  const selected = page.items.slice(0, cap);
  for (let i = 0; i < selected.length; i += 100) {
    await reserve(
      ctx,
      selected.slice(i, i + 100),
      i === 0 ? Math.max(0, page.items.length - cap) : 0,
    );
  }
  const excess = page.items.slice(cap);
  if (excess.length) {
    const drop = ctx.kv.atomic();
    for (const item of excess) drop.delete(item.key);
    await drop.commit();
  }
  if (page.cursor || existing.cursor) await ctx.schedule.after(1000, "flush");
}
async function rewriteCopy(ctx: Context, r: Row, keep: boolean) {
  if (!r.copy) return;
  // Settle an ambiguous send before trying to edit a bot-authored copy.
  if (await ctx.kv.get("work:" + r.copy)) {
    await deliver(ctx, r.copy);
    if (await ctx.kv.get("work:" + r.copy)) throw Error("copy reconciliation pending");
  }
  const key = "copy:" + r.copy,
    p = await ctx.kv.get<Plan>(key);
  if (!p?.message) return;
  const chan = ctx.server.channel({ id: p.channel }),
    msg = await chan.message(p.message);
  const ids = keep ? p.ids : p.ids.filter((x) => x !== r.id);
  if (msg) {
    if (msg.author.id !== ctx.bot.user.id)
      throw Error("cannot edit a message owned by another bot");
    const rows = await planRows(ctx, { ...p, ids });
    if (rows.length) await msg.edit(payload(ctx, rows, r.copy, p.dropped));
    else
      await msg.edit({
        content: tr(ctx, "redacted"),
        embeds: [],
        allowedMentions: { users: false, roles: false, everyone: false },
      });
  }
  if (ids.length) await ctx.kv.set(key, { ...p, ids });
  else await ctx.kv.delete(key);
}
async function reconcileCopy(ctx: Context, r: Row, keep: boolean) {
  if (!r.copy) return;
  const lock = "copy-lock:" + r.copy;
  if (
    !(
      await ctx.kv
        .atomic()
        .check(lock, undefined)
        .set(lock, true, { ttlSeconds: leaseSeconds })
        .commit()
    ).ok
  )
    throw Error("copy is being reconciled; retry");
  try {
    await rewriteCopy(ctx, r, keep);
  } finally {
    await ctx.kv.delete(lock);
  }
}
export async function eraseSubject(ctx: Context, r: Row, user: string) {
  const entry = await ctx.kv.getEntry<Row>("row:" + r.id);
  if (!entry || !entry.value.subjects.includes(user)) return;
  const remaining = entry.value.subjects.filter((id) => id !== user);
  if (!remaining.length) {
    await removeRow(ctx, entry.value);
    return;
  }
  const alias = await ctx.privacy.pseudonym(user);
  const safe: Row = {
    ...entry.value,
    subjects: remaining,
    text: tr(ctx, "shared", { alias, members: remaining.map((id) => "<@" + id + ">").join(", ") }),
  };
  delete safe.excerpt;
  delete safe.contentUntil;
  // Keep a member-free retry record until both the remote copy and index are clean.
  const repair = "repair:" + safe.id;
  if (
    !(
      await ctx.kv
        .atomic()
        .check("row:" + r.id, entry.version)
        .set("row:" + r.id, safe)
        .set(repair, { alias })
        .commit()
    ).ok
  )
    throw Error("observation changed; retry");
  await repairRow(ctx, safe);
}
export async function repairRow(ctx: Context, r: Row) {
  await reconcileCopy(ctx, r, true);
  if (await ctx.kv.get("indexed:" + r.id)) await searchIndex(ctx).remove(r.id);
  await indexRow(ctx, r);
  await ctx.kv.delete("repair:" + r.id);
}
export async function removeRow(ctx: Context, r: Row) {
  const current = await ctx.kv.getEntry<Row>("row:" + r.id);
  if (!current) return;
  if (!current.value.erasing) {
    const tx = ctx.kv
      .atomic()
      .check("row:" + r.id, current.version)
      .set("row:" + r.id, { ...current.value, erasing: true })
      .delete(qkey(r));
    if (!(await tx.commit()).ok) throw Error("observation changed; retry");
  }
  // If a remote copy or index is unavailable, the ordinary cleanup worker
  // picks this erasure up independently of the original admin request.
  const retry = "expiry:" + PAD(0) + ":" + r.id;
  await ctx.kv.set(retry, r.id);
  await reconcileCopy(ctx, current.value, false);
  // Deleting stale index contents remains required if the operator withdrew
  // the search grant; report failure rather than claiming erasure succeeded.
  if ((await ctx.kv.get("indexed:" + r.id)) || feature(ctx, "search"))
    await searchIndex(ctx).remove(r.id);
  await ctx.kv
    .atomic()
    .delete(retry)
    .delete("repair:" + r.id)
    .delete("indexed:" + r.id)
    .delete("row:" + r.id)
    .delete(qkey(r))
    .delete(expiryKey(r))
    .commit();
}
export async function housekeeping(ctx: Context) {
  const now = Date.now();
  for (const item of (await ctx.kv.list({ prefix: "repair:", limit: 30 })).items) {
    const row = await ctx.kv.get<Row>("row:" + item.key.slice(7));
    if (row) await repairRow(ctx, row);
    else await ctx.kv.delete(item.key);
  }
  const page = await ctx.kv.list({ prefix: "expiry:", limit: 40 });
  for (const { key, value } of page.items) {
    if (Number(key.split(":")[1]) > now) return;
    const row = await ctx.kv.get<Row>("row:" + value);
    if (row) await removeRow(ctx, row);
    else await ctx.kv.delete(key);
  }
  if (page.cursor) await ctx.schedule.after(25, "cleanup");
}
export async function migrate(ctx: Context) {
  if ((await ctx.kv.get("meta:schema")) === 2) return;
  const cursor = await ctx.kv.get<string>("migration:cursor");
  const page = await ctx.kv.list({ prefix: "q:", cursor, limit: 30 });
  const tx = ctx.kv.atomic();
  // v0.1 queue lines were pre-rendered and carried no subject/source metadata.
  // They cannot be copied safely. Discard only the obsolete unpublished backlog.
  for (const i of page.items) tx.delete(i.key);
  if (page.cursor) tx.set("migration:cursor", page.cursor);
  else tx.delete("migration:cursor").delete("pending").delete("seq").set("meta:schema", 2);
  await tx.commit();
  if (page.cursor) await ctx.schedule.after(10, "migrate");
}
