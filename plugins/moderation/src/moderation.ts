/** Cases, warnings, the audit log and the webhook, independent of the handlers. */
import type { Context, Embed, Json, User } from "@cicord/sdk";

type Action =
  | "warn"
  | "timeout"
  | "untimeout"
  | "kick"
  | "ban"
  | "tempban"
  | "unban"
  | "note"
  | "quarantine"
  | "release"
  | "purge"
  | "clear";

export type Case = {
  number: number;
  action: Action;
  member: { id: string; name: string } | null;
  /** null for automatic actions. */
  moderator: { id: string; name: string } | null;
  reason: string;
  durationMinutes?: number;
  status?: "active" | "expired" | "lifted" | "void" | "superseded" | "appealed";
  expiresAt?: string;
  source?: {
    type: "command" | "escalation" | "plugin" | "automod";
    plugin?: string;
    caller?: { plugin: string; bot: string; instance: string; source: string; verified: boolean };
  };
  evidence?: string;
  evidenceChannelId?: string;
  at: string;
};

/** Stored under `warn:<userId>:<case number>` with a TTL (warnings expire). */
export interface Warning {
  case: number;
  reason: string;
  moderator: string | null;
  evidence?: string;
  evidenceChannelId?: string;
  at: string;
}

const COLORS: Record<Action, string> = {
  warn: "#f1c40f",
  timeout: "#e67e22",
  untimeout: "#2ecc71",
  kick: "#e74c3c",
  ban: "#992d22",
  tempban: "#992d22",
  unban: "#2ecc71",
  note: "#95a5a6",
  purge: "#f39c12",
  quarantine: "#e67e22",
  release: "#2ecc71",
  clear: "#2ecc71",
};

export const warnPrefix = (userId: string): string => `warn:${userId}:`;

export function who(user: User, displayName?: string): { id: string; name: string } {
  return { id: user.id, name: displayName ?? user.displayName };
}

export function duration(ctx: Context, minutes: number): string {
  if (minutes % 1440 === 0)
    return ctx.i18n.t(minutes === 1440 ? "duration.day" : "duration.days", { n: minutes / 1440 });
  if (minutes % 60 === 0) return ctx.i18n.t("duration.hours", { n: minutes / 60 });
  return ctx.i18n.t("duration.minutes", { n: minutes });
}

function caseEmbed(ctx: Context, c: Case): Embed {
  const fields: NonNullable<Embed["fields"]> = [
    ...(c.member
      ? [
          {
            name: ctx.i18n.t("case.member"),
            value: `<@${c.member.id}> (${c.member.name})`,
            inline: true,
          },
        ]
      : []),
    {
      name: ctx.i18n.t("case.moderator"),
      value: c.moderator ? `<@${c.moderator.id}>` : "automatic",
      inline: true,
    },
  ];
  if (c.durationMinutes)
    fields.push({
      name: ctx.i18n.t("case.duration"),
      value: duration(ctx, c.durationMinutes),
      inline: true,
    });
  fields.push({ name: ctx.i18n.t("case.reason"), value: c.reason || "—" });
  if (c.evidence) fields.push({ name: ctx.i18n.t("case.evidence"), value: c.evidence });
  const image = c.evidence && /\.(png|jpe?g|gif|webp)(\?|$)/i.test(c.evidence);
  return {
    title: ctx.i18n.t("case.title", {
      number: c.number,
      action: ctx.i18n.t("actions." + c.action),
    }),
    color: COLORS[c.action],
    fields,
    ...(image ? { image: { url: c.evidence as string } } : {}),
    timestamp: c.at,
  };
}

export function normalizedCase(c: Case): Case {
  return {
    ...c,
    status: c.status ?? "active",
    source: c.source ?? { type: c.moderator ? "command" : "escalation" },
  };
}
export async function readCase(ctx: Context, number: number) {
  const c = await ctx.kv.get<Case>(`case:${number}`);
  return c && caseTTL(c.at) > 0 ? normalizedCase(c) : undefined;
}

/** Retention follows the original case timestamp, including after edits or retries. */
export function caseTTL(at: string): number {
  const seconds = Math.ceil((Date.parse(at) + 365 * 86_400_000 - Date.now()) / 1000);
  return Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
}

/** Re-read on contention and preserve independent edits and the original retention deadline. */
export async function editCase(ctx: Context, number: number, change: Partial<Case>) {
  const k = "case:" + number;
  for (let attempt = 0; attempt < 8; attempt++) {
    const entry = await ctx.kv.getEntry<Case>(k);
    if (!entry) return undefined;
    const ttlSeconds = caseTTL(entry.value.at);
    if (!ttlSeconds) return undefined;
    const c = { ...normalizedCase(entry.value), ...change };
    if ((await ctx.kv.atomic().check(k, entry.version).set(k, c, { ttlSeconds }).commit()).ok)
      return c;
  }
  throw new Error("Case changed concurrently.");
}

/** Lexical KV pagination lists newer cases first without scanning all cases. */
export async function indexCase(ctx: Context, c: Case) {
  if (c.moderator && !c.moderator.id.startsWith("deleted-user-") && c.action !== "note") {
    const marker = "stats-case:" + c.number,
      counter = "moderator-total:" + c.moderator.id;
    for (let i = 0; i < 10; i++) {
      if (await ctx.kv.get(marker)) break;
      const entry = await ctx.kv.getEntry<number>(counter),
        score = (entry?.value ?? 0) + 1;
      const result = await ctx.kv
        .atomic()
        .check(marker, undefined)
        .check(counter, entry?.version)
        .set(marker, true)
        .set(counter, score)
        .rankSet("moderators", c.moderator.id, score)
        .commit();
      if (result.ok) break;
      if (i === 9)
        throw new Error("Concurrent moderation statistic update. Retry indexing this case.");
    }
  }
  const ttlSeconds = caseTTL(c.at);
  if (c.member && ttlSeconds > 0)
    await ctx.kv.set(
      `case-user:${c.member.id}:${String(Number.MAX_SAFE_INTEGER - c.number).padStart(16, "0")}`,
      c.number,
      { ttlSeconds },
    );
}

/** Records a case and writes it to the audit log (and the webhook). */
export async function recordCase(ctx: Context, c: Omit<Case, "number" | "at">): Promise<Case> {
  const full: Case = {
    ...c,
    number: await ctx.kv.increment("cases"),
    at: new Date().toISOString(),
  };
  return saveNewCase(ctx, full);
}

type Delivery = {
  taskId: string;
  channelId: string;
  event1?: boolean;
  event2?: boolean;
  webhookAttempted?: boolean;
  staffAttemptedAt?: number;
};

const deliveryKey = (number: number) => `case-delivery:${number}`;
const sending = new Map<number, Promise<void>>();

/** Fence overlapping handlers from different runtime processes. The KV version
 * prevents a late handler from releasing its successor's lock after a restart. */
export async function withModerationLock<T>(
  ctx: Context,
  key: string,
  work: () => Promise<T>,
): Promise<T> {
  const owner = await ctx.kv.increment("moderation-lock-sequence");
  const acquired = await ctx.kv
    .atomic()
    .check(key, null)
    .set(key, owner, { ttlSeconds: 30 })
    .commit();
  if (!acquired.ok) throw new Error("Another moderation handler is running; retry shortly");
  try {
    return await work();
  } finally {
    const held = await ctx.kv.getEntry<number>(key);
    if (held?.value === owner) await ctx.kv.atomic().check(key, held.version).delete(key).commit();
  }
}

/** The case and its outbox are created together. Already stored legacy cases
 * have no outbox and must not suddenly be announced after an upgrade. */
export async function saveNewCase(ctx: Context, full: Case): Promise<Case> {
  const key = `case:${full.number}`;
  const ttlSeconds = caseTTL(full.at);
  if (ttlSeconds === 0) return full;
  let entry = await ctx.kv.get<Case>(key);
  if (!entry) {
    full.source ??= { type: full.moderator ? "command" : "escalation" };
    full.status ??= "active";
    if (full.action === "note") {
      await ctx.kv.atomic().check(key, null).set(key, full, { ttlSeconds }).commit();
    } else {
      const channelId = ctx.server.channel(ctx.config.logChannel).id;
      // Arm recovery before materializing the case. A crash before the transaction
      // leaves a harmless task; one after it always leaves a worker for its outbox.
      const task = await ctx.schedule.after(120_000, "deliverCase", { number: full.number });
      const delivery: Delivery = { taskId: task.id, channelId };
      const created = await ctx.kv
        .atomic()
        .check(key, null)
        .set(key, full, { ttlSeconds })
        .set(deliveryKey(full.number), delivery, { ttlSeconds })
        .commit();
      if (!created.ok) await ctx.schedule.cancel(task.id);
    }
    entry = await ctx.kv.get<Case>(key);
    if (!entry) throw new Error("Case could not be recorded");
  }
  await indexCase(ctx, entry);
  if (entry.action !== "note") {
    try {
      await deliverCase(ctx, { number: entry.number });
    } catch {
      // The sanction or warning may already be effective. Durable recovery
      // handles notification failures without repeating the moderation command.
      ctx.log.warn("Case notification pending recovery", { number: entry.number });
    }
  }
  return entry;
}

export async function deliverCase(ctx: Context, payload?: Json): Promise<void> {
  const number = (payload as { number?: number } | undefined)?.number;
  if (!number || !Number.isSafeInteger(number)) throw new Error("Invalid case delivery task");
  const current = sending.get(number);
  if (current) return current;
  const attempt = withModerationLock(ctx, `case-delivery-lock:${number}`, () =>
    deliver(ctx, number),
  );
  sending.set(number, attempt);
  try {
    await attempt;
  } finally {
    sending.delete(number);
  }
}

async function deliver(ctx: Context, number: number) {
  const key = deliveryKey(number);
  const d = await ctx.kv.get<Delivery>(key);
  if (!d) return;
  const c = await readCase(ctx, number);
  const ttlSeconds = c ? caseTTL(c.at) : 0;
  if (!c || c.action === "note" || !ttlSeconds) {
    await ctx.kv.delete(key);
    return;
  }
  await indexCase(ctx, c);
  // Only explicitly public contract fields leave moderation. Staff evidence is
  // never shared with event subscribers, including in the legacy projection.
  const v1 = {
    number: c.number,
    at: c.at,
    action: c.action,
    member: c.member,
    moderator: c.moderator,
    reason: c.reason,
    ...(c.durationMinutes !== undefined ? { durationMinutes: c.durationMinutes } : {}),
  };
  if (!d.event1) {
    await ctx.events.publish("case", v1, { version: 1, idempotencyKey: `case:${number}:v1` });
    d.event1 = true;
    await ctx.kv.set(key, d, { ttlSeconds });
  }
  if (!d.event2) {
    const v2 = {
      ...v1,
      source: c.source ?? { type: c.moderator ? "command" : "escalation" },
      status: c.status ?? "active",
      ...(c.expiresAt ? { expiresAt: c.expiresAt } : {}),
    };
    await ctx.events.publish("case", v2, { version: 2, idempotencyKey: `case:${number}:v2` });
    d.event2 = true;
    await ctx.kv.set(key, d, { ttlSeconds });
  }
  if (!d.webhookAttempted && (ctx.secrets.has("WEBHOOK_URL") || ctx.config.webhook?.url)) {
    d.webhookAttempted = true;
    await ctx.kv.set(key, d, { ttlSeconds });
    await notifyWebhook(
      ctx,
      `Case #${number} · ${ctx.i18n.t("actions." + c.action)}: ${c.member?.name ?? "channel"} — ${c.reason || "no reason"}${c.moderator ? ` (by ${c.moderator.name})` : ""}`,
    );
  }
  const channel = ctx.server.channel({ id: d.channelId });
  const nonce = d.taskId.slice(0, 25);
  const footer = `Case delivery ${nonce}`;
  let found = false;
  if (d.staffAttemptedAt !== undefined) {
    const recent = await channel.messages({ limit: 100 });
    found = recent.some(
      (m) => m.author.id === ctx.bot.user.id && m.embeds.some((e) => e.footer?.text === footer),
    );
    // Discord only remembers an enforced nonce for a few minutes. When a busy
    // channel has moved beyond the recorded attempt we cannot prove absence.
    if (
      !found &&
      Date.now() - d.staffAttemptedAt > 120_000 &&
      recent.length === 100 &&
      recent.every((m) => m.createdAt.getTime() >= d.staffAttemptedAt!)
    )
      throw new Error(
        "Staff log delivery is uncertain after 100 newer messages; staff review required",
      );
  } else {
    d.staffAttemptedAt = Date.now();
    await ctx.kv.set(key, d, { ttlSeconds });
  }
  if (!found) {
    let evidence: string | undefined;
    if (c.evidence && c.evidenceChannelId) {
      const relation = ctx.server.compareAudience({ id: c.evidenceChannelId }, channel);
      if (relation === "same" || relation === "narrower") evidence = c.evidence;
    }
    await channel.send({
      embeds: [{ ...caseEmbed(ctx, { ...c, evidence }), footer: { text: footer } }],
      nonce,
      enforceNonce: true,
      allowedMentions: { users: false, roles: false, everyone: false },
    });
  }
  await ctx.kv.delete(key);
  await ctx.schedule.cancel(d.taskId);
}

/** Plain audit log line (joins, leaves, updates). */
export async function logLine(ctx: Context, text: string, color = "#95a5a6"): Promise<void> {
  await ctx.server.channel(ctx.config.logChannel).send({
    embeds: [{ description: text, color, timestamp: new Date().toISOString() }],
    allowedMentions: { users: false, roles: false, everyone: false },
  });
}

/** Posts to the optional webhook. Failures are logged, never thrown. */
async function notifyWebhook(ctx: Context, text: string): Promise<void> {
  const hook = ctx.config.webhook;
  const url = ctx.secrets.has("WEBHOOK_URL") ? ctx.secrets.ref("WEBHOOK_URL") : hook?.url;
  if (!url) return;
  const payload: Record<string, Json> =
    hook?.format === "discord" ? { content: text, allowed_mentions: { parse: [] } } : { text };
  try {
    const res = await ctx.http.fetch(url, { method: "POST", json: payload, timeoutMs: 5000 });
    if (res.status >= 300)
      ctx.log.warn("moderation: webhook refused the message", { status: res.status });
  } catch {
    ctx.log.warn("moderation: webhook failed");
  }
}

export async function activeWarnings(ctx: Context, userId: string): Promise<Warning[]> {
  const { items } = await ctx.kv.list({ prefix: warnPrefix(userId), limit: 1000 });
  return items.map((i) => i.value as unknown as Warning).toSorted((a, b) => a.case - b.case);
}
