/**
 * KV schema 2: every ticket record carries `ix: 2` once its indexes exist. The indexes are
 * derived from the record and written in the same atomic commit as the record itself
 * (`saveTicket`), so concurrent invocation realms can never commit a record without its
 * indexes. Only `who:` keys (a positive-only lookup used by privacy hooks) are written just
 * before the commit: a failed commit leaves a harmless extra key.
 *
 * - ranking `due`: member = ticket number, score = −(next time maintenance must look at it).
 * - `copy:<n>`: closed tickets with a log delivery to reconcile.
 * - `req:<caller>:<key>` → n: the idempotency receipt of the `open` action.
 * - `appeal:<publisher>:<case>:<user>:<n>`: appeal tickets by (case, member).
 * - `who:<user>:<n>`: tickets that name a member (privacy export and erase).
 * - `rating:count:<type>` / `rating:sum:<type>`: portal statistics.
 */
import type { PluginConfig } from "@cicord/sdk";

export const SCHEMA = 2;
export const SCHEMA_KEY = "meta:schema";
/** Fingerprint of the config the `due` ranking was computed with. */
export const INDEXED_KEY = "meta:indexed";
export const REINDEX_KEY = "meta:reindex";
export const DUE = "due";

export const pad = (n: number): string => String(n).padStart(8, "0");
export const copyKey = (n: number) => "copy:" + pad(n);
export const whoPrefix = (userId: string) => "who:" + userId + ":";
export const whoKey = (userId: string, n: number) => whoPrefix(userId) + pad(n);
export const ratingCount = (type: string) => "rating:count:" + type;
export const ratingSum = (type: string) => "rating:sum:" + type;

const token = (s: string) => {
  let h = 14695981039346656037n;
  for (const ch of s) h = BigInt.asUintN(64, (h ^ BigInt(ch.codePointAt(0)!)) * 1099511628211n);
  return h.toString(36);
};
const bytes = (s: string) => {
  let n = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
  }
  return n;
};

export type Request = { caller: string; key: string };
/** Direct receipt key of an `open` request. Callers are `bot/instance` (no colon). */
export function reqKey(r: Request): string {
  const raw = "req:" + r.caller + ":" + r.key;
  return bytes(raw) <= 500 ? raw : "req#" + token(r.caller + "\n" + r.key);
}
export const sameRequest = (a?: Request, b?: Request) =>
  !!a && !!b && a.caller === b.caller && a.key === b.key;

export type Appeal = { number: number; bot: string; instance: string };
export const appealPrefix = (a: Appeal, userId: string) =>
  "appeal:" + encodeURIComponent(a.bot + "/" + a.instance) + ":" + a.number + ":" + userId + ":";
export const appealKey = (a: Appeal, userId: string, n: number) => appealPrefix(a, userId) + pad(n);
/** Status of an appeal event received while schema-1 records were still being indexed. */
export const appealPendingKey = (a: Appeal, userId: string) =>
  "appealPending:" + appealPrefix(a, userId).slice("appeal:".length);

type Config = Pick<
  Readonly<PluginConfig>,
  "firstResponseMinutes" | "inactivityHours" | "recordRetentionDays" | "transcriptRetentionDays"
>;

export const fingerprint = (c: Config) =>
  JSON.stringify([
    c.firstResponseMinutes,
    c.inactivityHours,
    c.recordRetentionDays,
    c.transcriptRetentionDays,
  ]);

const H = 3600000;

/** The fields of a ticket that decide when maintenance must look at it. */
export interface DueFields {
  status: "open" | "closed";
  createdAt: string;
  closedAt?: string;
  provision?: { phase: string; since: number };
  reminded?: boolean;
  firstResponseAt?: string;
  warningAt?: number;
  pendingClose?: boolean;
  expiresAt?: number;
  logDelivery?: { phase: string };
}

/**
 * The earliest time a maintenance pass has work on this ticket, or undefined when it never
 * will. A value earlier than the real need is harmless (maintenance re-evaluates and
 * reschedules); a later one would delay work, so every term is a lower bound.
 */
export function dueAt(c: Config, t: DueFields, last?: string): number | undefined {
  const created = Date.parse(t.createdAt);
  const due: number[] = [];
  if (t.status === "open") {
    if (t.provision)
      return Math.max(created + 60000, t.provision.phase === "creating" ? t.provision.since + 120000 : 0);
    if (!t.reminded && !t.firstResponseAt && c.firstResponseMinutes > 0)
      due.push(created + c.firstResponseMinutes * 60000);
    if (c.inactivityHours > 0) {
      const activity = Math.max(created, last ? Date.parse(last) || 0 : 0);
      due.push(
        t.warningAt === undefined
          ? activity + c.inactivityHours * H - H
          : Math.max(activity + c.inactivityHours * H, t.warningAt + H),
      );
    }
  } else {
    const closed = t.closedAt ? Date.parse(t.closedAt) : created;
    if (t.pendingClose) return 0;
    if (t.logDelivery && (t.logDelivery.phase === "pending" || t.logDelivery.phase === "attaching"))
      return closed;
    if (t.expiresAt) due.push(t.expiresAt);
    due.push(closed + Math.max(c.recordRetentionDays, c.transcriptRetentionDays) * 86400000);
  }
  return due.length ? Math.min(...due) : undefined;
}

const MENTION = /<@!?(\d{1,20})>/g;
export function mentioned(text: string | undefined, into: Set<string>) {
  if (text) for (const m of text.matchAll(MENTION)) into.add(m[1]!);
}

type Named = { id: string } | null | undefined;
export interface Involved {
  author: { id: string };
  assignee: Named;
  closedBy?: Named;
  subject: string;
  description: string;
  closeReason?: string;
  events: { by: { id: string } }[];
  notes: { by: { id: string }; content: string }[];
  summary?: { participants: { id: string }[] };
  copies?: { userId: string }[];
  directCopies?: { authorId: string }[];
  notices?: { users: string[] }[];
  closedAudience?: { members: string[]; denied: string[] };
}

/** Every member a ticket record names, including `<@id>` mentions in its stored text. */
export function involved(t: Involved): Set<string> {
  const ids = new Set<string>([t.author.id]);
  for (const p of [t.assignee, t.closedBy, ...t.events.map((e) => e.by), ...t.notes.map((n) => n.by)])
    if (p) ids.add(p.id);
  for (const p of t.summary?.participants ?? []) ids.add(p.id);
  for (const c of t.copies ?? []) ids.add(c.userId);
  for (const c of t.directCopies ?? []) ids.add(c.authorId);
  for (const n of t.notices ?? []) for (const u of n.users) ids.add(u);
  for (const u of [...(t.closedAudience?.members ?? []), ...(t.closedAudience?.denied ?? [])])
    ids.add(u);
  mentioned(t.subject, ids);
  mentioned(t.description, ids);
  mentioned(t.closeReason, ids);
  for (const n of t.notes) mentioned(n.content, ids);
  return ids;
}
