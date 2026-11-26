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
  status?: "active" | "expired" | "lifted" | "void" | "superseded";
  expiresAt?: string;
  source?: { type: "command" | "escalation" | "plugin" | "automod"; plugin?: string };
  evidence?: string;
  at: string;
};

/** Stored under `warn:<userId>:<case number>` with a TTL (warnings expire). */
export interface Warning {
  case: number;
  reason: string;
  moderator: string | null;
  evidence?: string;
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
  clear: "#2ecc71",
};

const TITLES: Record<Action, string> = {
  warn: "Warning",
  timeout: "Timeout",
  untimeout: "Timeout removed",
  kick: "Kick",
  ban: "Ban",
  tempban: "Temporary ban",
  unban: "Ban lifted",
  note: "Staff note",
  purge: "Purge",
  clear: "Warnings cleared",
};

export const warnPrefix = (userId: string): string => `warn:${userId}:`;

export function who(user: User, displayName?: string): { id: string; name: string } {
  return { id: user.id, name: displayName ?? user.displayName };
}

export function duration(minutes: number): string {
  if (minutes % 1440 === 0) return `${minutes / 1440} day${minutes === 1440 ? "" : "s"}`;
  if (minutes % 60 === 0) return `${minutes / 60} h`;
  return `${minutes} min`;
}

function caseEmbed(c: Case): Embed {
  const fields: NonNullable<Embed["fields"]> = [
    ...(c.member
      ? [{ name: "Member", value: `<@${c.member.id}> (${c.member.name})`, inline: true }]
      : []),
    { name: "Moderator", value: c.moderator ? `<@${c.moderator.id}>` : "automatic", inline: true },
  ];
  if (c.durationMinutes)
    fields.push({ name: "Duration", value: duration(c.durationMinutes), inline: true });
  fields.push({ name: "Reason", value: c.reason || "—" });
  if (c.evidence) fields.push({ name: "Evidence", value: c.evidence });
  const image = c.evidence && /\.(png|jpe?g|gif|webp)(\?|$)/i.test(c.evidence);
  return {
    title: `Case #${c.number} · ${TITLES[c.action]}`,
    color: COLORS[c.action],
    fields,
    ...(image ? { image: { url: c.evidence as string } } : {}),
    timestamp: c.at,
  };
}

export async function readCase(ctx: Context, number: number) {
  return ctx.kv.get<Case>(`case:${number}`);
}

/** Lexical KV pagination lists newer cases first without scanning all cases. */
export async function indexCase(ctx: Context, c: Case) {
  if (c.member)
    await ctx.kv.set(
      `case-user:${c.member.id}:${String(Number.MAX_SAFE_INTEGER - c.number).padStart(16, "0")}`,
      c.number,
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

export async function saveNewCase(ctx: Context, full: Case): Promise<Case> {
  const key = `case:${full.number}`;
  const already = await ctx.kv.get<Case>(key);
  if (already) {
    await indexCase(ctx, already);
    return already;
  }
  full.source ??= { type: full.moderator ? "command" : "escalation" };
  full.status ??= "active";
  await ctx.kv.set(key, full as unknown as Json);
  await indexCase(ctx, full);
  await ctx.server.channel(ctx.config.logChannel).send({
    embeds: [caseEmbed(full)],
    allowedMentions: { users: false, roles: false, everyone: false },
  });
  await notifyWebhook(
    ctx,
    `Case #${full.number} · ${TITLES[full.action]}: ${full.member?.name ?? "channel"} — ${full.reason || "no reason"}${full.moderator ? ` (by ${full.moderator.name})` : ""}`,
  );
  // moderation.case: other plugins (audit-log) can record sanctions.
  await ctx.events.publish("case", full as unknown as Json);
  return full;
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
  if (!hook) return;
  const body =
    hook.format === "discord" ? { content: text, allowed_mentions: { parse: [] } } : { text };
  try {
    const res = await ctx.http.fetch(hook.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      timeoutMs: 5000,
    });
    if (res.status >= 300)
      ctx.log.warn("moderation: webhook refused the message", { status: res.status });
  } catch (error) {
    ctx.log.warn("moderation: webhook failed", { error: String(error) });
  }
}

export async function activeWarnings(ctx: Context, userId: string): Promise<Warning[]> {
  const { items } = await ctx.kv.list({ prefix: warnPrefix(userId), limit: 1000 });
  return items.map((i) => i.value as unknown as Warning).toSorted((a, b) => a.case - b.case);
}
