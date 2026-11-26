import { repairRelayPage } from "./relay.ts";
import type { Context, Json, TextChannel } from "@cicord/sdk";
import {
  TicketConflict,
  authorKey,
  closeTicket,
  deleteRecord,
  provisionTicket,
  finishClose,
  getTicket,
  lastActivityKey,
  normalize,
  refreshDue,
  saveTicket,
  ticketChannel,
  ticketType,
  type Ticket,
} from "./tickets.ts";
import { purgeArchive, readPage, reconcileCopy, reconcilePage } from "./transcript.ts";
import {
  DUE,
  INDEXED_KEY,
  REINDEX_KEY,
  SCHEMA,
  SCHEMA_KEY,
  appealPendingKey,
  fingerprint,
  mentioned,
  whoKey,
} from "./indexes.ts";

/** Per run of the every-minute cron: tickets taken from the head of the `due` ranking,
 * pending relays and tracked log copies (both rotate through their keys with a cursor). */
export const DUE_PAGE = 25;
const RELAY_PAGE = 20;
const COPY_PAGE = 10;
/** Work that is still due after a pass (failure, missing channel) waits this long. */
const RETRY_MS = 5 * 60000;
/** Stop taking new tickets after this much of the handler deadline. */
const BUDGET_MS = 6000;

export async function maintenance(ctx: Context) {
  const started = Date.now();
  await ensureIndexed(ctx);
  for (const row of await ctx.kv.ranking(DUE).top({ limit: DUE_PAGE })) {
    if (-row.score > Date.now() || Date.now() - started > BUDGET_MS) break;
    await maintainTicket(ctx, Number(row.member));
  }
  await rotate(ctx, "maint:relays", (cursor) => repairRelayPage(ctx, cursor, RELAY_PAGE));
  await rotate(ctx, "maint:copies", (cursor) => reconcilePage(ctx, cursor, COPY_PAGE));
}

async function rotate(
  ctx: Context,
  key: string,
  page: (cursor: string | undefined) => Promise<string | undefined>,
) {
  const next = await page(await ctx.kv.get<string>(key));
  if (next) await ctx.kv.set(key, next);
  else await ctx.kv.delete(key);
}

export async function maintainTicket(ctx: Context, n: number) {
  const t = await getTicket(ctx, n);
  if (!t) {
    await ctx.kv.ranking(DUE).remove(String(n));
    return;
  }
  try {
    await work(ctx, t);
  } catch (error) {
    ctx.log.warn("Ticket maintenance deferred", { ticket: t.id, error: String(error) });
  }
  await refreshDue(ctx, n, Date.now() + RETRY_MS);
}

async function work(ctx: Context, t: Ticket) {
  if (t.provision && t.status === "open") {
    await provisionTicket(ctx, t);
    return;
  }
  if (t.status === "closed") {
    if (t.pendingClose) await finishClose(ctx, t);
    const phase = t.logDelivery?.phase;
    if (t.logCopy || phase === "pending" || phase === "attaching") await reconcileCopy(ctx, t);
    if (t.expiresAt && Date.now() >= t.expiresAt) {
      if (t.directCopies?.length && !ctx.features.enabled("modmail")) {
        // Keep the receipts until record deletion: they can still be retracted if the
        // grant returns before then (a later pass of this ticket retries).
        ctx.log.warn("Expired DM copies kept: modmail (discord.dm.send) is not granted", {
          ticket: t.id,
        });
        ctx.status.set("dmCopies", "Expired DM copies wait for discord.dm.send");
      } else {
        for (const c of t.directCopies ?? []) await ctx.server.retractDM(c.messageId);
        delete t.directCopies;
      }
      delete t.copies;
      delete t.notices;
      await purgeArchive(ctx, t);
      await saveTicket(ctx, t);
    }
    if (
      t.closedAt &&
      Date.now() - Date.parse(t.closedAt) >=
        Math.max(ctx.config.recordRetentionDays, ctx.config.transcriptRetentionDays) * 86400000
    )
      await deleteRecord(ctx, t.number);
    return;
  }
  const last = (await ctx.kv.get<string>(lastActivityKey(t.number))) ?? t.createdAt;
  const channel = ticketChannel(ctx, t);
  if (!channel) return;
  const type = ticketType(ctx, t.type);
  if (
    !t.reminded &&
    !t.firstResponseAt &&
    ctx.config.firstResponseMinutes > 0 &&
    Date.now() - Date.parse(t.createdAt) >= ctx.config.firstResponseMinutes * 60000
  ) {
    const roles = type?.staffRoles.map((k) => ctx.server.role(k)) ?? [];
    const marker = "⏱ " + t.createdAt;
    if (!(await sentNotice(ctx, channel, marker)))
      await channel.send({
        embeds: [{ footer: { text: marker }, description: ctx.i18n.t("responseRequested") }],
        content: ctx.i18n.t("responseOverdue", {
          staff: roles.map((r) => r.mention).join(" "),
        }),
        allowedMentions: { roles: roles.map((r) => r.id), users: false, everyone: false },
      });
    t.reminded = true;
    await saveTicket(ctx, t);
  }
  if (ctx.config.inactivityHours <= 0) return;
  const due = Date.parse(last) + ctx.config.inactivityHours * 3600000;
  if (!t.warningAt && Date.now() >= due - 3600000) {
    const marker = "⏳ " + last;
    const warning =
      (await sentNotice(ctx, channel, marker)) ??
      (await channel.send({
        content: ctx.i18n.t("warning"),
        embeds: [{ footer: { text: marker }, description: ctx.i18n.t("warningTitle") }],
      }));
    t.warningAt = warning.createdAt.getTime();
    await saveTicket(ctx, t);
  } else if (t.warningAt && Date.now() >= Math.max(due, t.warningAt + 3600000)) {
    const current = await getTicket(ctx, t.number);
    if (current?.status === "open" && current.warningAt === t.warningAt)
      await closeTicket(
        ctx,
        current,
        { id: ctx.bot.user.id, displayName: ctx.bot.user.displayName },
        ctx.i18n.t("inactivity"),
      );
  }
}

export async function receivedReply(
  ctx: Context,
  t: Ticket,
  at: Date,
  staff: boolean,
  relay = false,
) {
  const changed = relay || t.warningAt !== undefined || (staff && !t.firstResponseAt);
  if (staff) t.firstResponseAt ??= at.toISOString();
  delete t.warningAt;
  if (changed) await saveTicket(ctx, t);
  // The `due` entry is not rewritten here: it may now be early, and the pass that takes it
  // re-reads the activity time and reschedules (src/indexes.ts, dueAt).
  await ctx.kv.set(lastActivityKey(t.number), at.toISOString());
}

async function sentNotice(ctx: Context, channel: TextChannel, marker: string) {
  return (await channel.messages({ limit: 100 })).find(
    (m) => m.author.id === ctx.bot.user.id && m.embeds.some((e) => e.footer?.text === marker),
  );
}

// ───────────────────────────────────────────────────────────── schema 2 migration

type Reindex = { fingerprint: string; cursor?: string; at: number };
const REINDEX_PAGE = 20;
/** A pass whose task was lost is restarted after this long without progress. */
const STALLED_MS = 10 * 60000;

/** Schedules the `reindex` task when records lack schema-2 indexes, or when the config the
 * `due` ranking was computed with changed. Read-only when everything is current. */
export async function ensureIndexed(ctx: Context) {
  const [schema, indexed] = await ctx.kv.getMany([SCHEMA_KEY, INDEXED_KEY]);
  if (schema === SCHEMA && indexed === fingerprint(ctx.config)) return;
  const state = (await ctx.kv.get(REINDEX_KEY)) as unknown as Reindex | undefined;
  if (state && state.fingerprint === fingerprint(ctx.config) && Date.now() - state.at < STALLED_MS)
    return;
  await ctx.schedule.after(0, "reindex");
}

/**
 * One bounded, resumable page of the schema-2 migration (0.2.1/0.4.0 records) or of a
 * `due` recomputation after a config change. The cursor is committed with a version check:
 * a duplicate task that loses the race stops, and a restart resumes from the last page.
 */
export async function reindex(ctx: Context) {
  const fp = fingerprint(ctx.config);
  const entry = await ctx.kv.getEntry(REINDEX_KEY);
  let state = entry?.value as unknown as Reindex | undefined;
  if (!state) {
    const [schema, indexed] = await ctx.kv.getMany([SCHEMA_KEY, INDEXED_KEY]);
    if (schema === SCHEMA && indexed === fp) return;
  }
  if (state?.fingerprint !== fp) state = { fingerprint: fp, at: Date.now() };
  const page = await ctx.kv.list({
    prefix: "ticket:",
    limit: REINDEX_PAGE,
    ...(state.cursor ? { cursor: state.cursor } : {}),
  });
  for (const item of page.items) await indexRecord(ctx, item.value as unknown as Ticket);
  const tx = ctx.kv.atomic().check(REINDEX_KEY, entry?.version);
  if (page.cursor)
    tx.set(REINDEX_KEY, { fingerprint: fp, cursor: page.cursor, at: Date.now() } as Json);
  else tx.delete(REINDEX_KEY).set(SCHEMA_KEY, SCHEMA).set(INDEXED_KEY, fp);
  if (!(await tx.commit()).ok) return;
  if (page.cursor) await ctx.schedule.after(10, "reindex");
  else
    for (const item of (await ctx.kv.list({ prefix: "appealPending:", limit: 100 })).items)
      await ctx.kv.delete(item.key);
}

async function indexRecord(ctx: Context, raw: Ticket) {
  // A schema-1 record may already have been saved (and marked) by a normal write since the
  // upgrade: the author index, transcript members and pending appeal status come from here.
  const t = normalize(raw);
  await ctx.kv.set(authorKey(t.author.id, t.number), true);
  if (t.expiresAt && t.expiresAt > Date.now()) {
    const ttlSeconds = Math.ceil((t.expiresAt - Date.now()) / 1000);
    for (let p = 0; p < (t.transcriptPages ?? 0); p++) {
      const named = new Set<string>();
      for (const l of await readPage(ctx, t, p)) {
        named.add(l.author.id);
        mentioned(l.text, named);
      }
      for (const id of named) await ctx.kv.set(whoKey(id, t.number), true, { ttlSeconds });
    }
  }
  let changed = raw.ix !== SCHEMA;
  if (t.appeal) {
    const status = await ctx.kv.get<string>(appealPendingKey(t.appeal, t.author.id));
    if (status !== undefined && t.appeal.status !== status) {
      t.appeal.status = status;
      changed = true;
    }
  }
  if (!changed) {
    await refreshDue(ctx, t.number);
    return;
  }
  try {
    // The save derives every other index and marks the record.
    await saveTicket(ctx, t);
  } catch (error) {
    // A concurrent save already indexed it, or an erasure in progress will.
    if (!(error instanceof TicketConflict)) throw error;
  }
}
