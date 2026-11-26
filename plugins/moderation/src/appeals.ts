import type { Context, RouteRequest, RouteResponse } from "@cicord/sdk";
import { editCase, readCase, who, warnPrefix, type Case } from "./moderation.ts";
import { liftBanIfCurrent } from "./bans.ts";
import { release } from "./quarantine.ts";
import { memberCase } from "./cases.ts";
import { serialize } from "./queue.ts";

export type Appeal = {
  case: number;
  userId: string;
  text: string;
  status: "pending" | "accepted" | "rejected";
  submittedAt: string;
  decidedAt?: string;
  by?: string;
  resolution?: string;
  ticket?: string;
  notified?: boolean;
};
const key = (number: number) => "appeal:" + number;
const save = (ctx: Context, a: Appeal) =>
  ctx.kv.set(key(a.case), a, {
    ttlSeconds: Math.max(
      1,
      Math.ceil((Date.parse(a.submittedAt) + 365 * 86400000 - Date.now()) / 1000),
    ),
  });
const safeNumber = (id: string | undefined) =>
  id && /^[1-9]\d*$/.test(id) && Number.isSafeInteger(Number(id)) ? Number(id) : undefined;
const enabled = (ctx: Context) => !!ctx.config.appeals?.enabled && ctx.features.enabled("appeals");
export async function appealLink(ctx: Context, c: Case) {
  if (!enabled(ctx) || !c.member || c.action === "note") return "";
  const path =
    "/appeals?bot=" +
    encodeURIComponent(ctx.bot.key) +
    "&instance=" +
    encodeURIComponent(ctx.plugin.instance) +
    "&case=" +
    c.number;
  return ctx.portal.link(path, {
    user: c.member.id,
    scope: { kind: "case", id: String(c.number) },
    expiresInSeconds: 7 * 86400,
  });
}
export async function linkMessage(ctx: Context, c: Case, message: string) {
  const url = await appealLink(ctx, c);
  return url ? message + "\n" + ctx.i18n.t("appeal.link", { number: c.number, url }) : message;
}
async function scopedCase(ctx: Context, r: RouteRequest) {
  const number = safeNumber(r.scope?.id);
  if (!enabled(ctx) || r.scope?.kind !== "case" || !number || !r.viewer) return undefined;
  const c = await readCase(ctx, number);
  return c?.member?.id === r.viewer.user.id &&
    !["note", "purge", "clear", "release", "unban", "untimeout"].includes(c.action)
    ? c
    : undefined;
}
export async function caseView(ctx: Context, r: RouteRequest): Promise<RouteResponse> {
  const c = await scopedCase(ctx, r);
  if (!c) return { status: 403 };
  const a = await ctx.kv.get<Appeal>(key(c.number));
  return {
    case: memberCase(c),
    appeal: a ? { case: a.case, text: a.text, status: a.status } : null,
  };
}
export async function submitAppeal(ctx: Context, r: RouteRequest): Promise<RouteResponse> {
  const c = await scopedCase(ctx, r);
  if (!c || !c.member) return { status: 403 };
  const user = c.member.id;
  const b = r.body as { text?: unknown; case?: unknown } | null;
  if (b?.case !== undefined && String(b.case) !== String(c.number)) return { status: 403 };
  if (typeof b?.text !== "string" || !b.text.trim() || b.text.length > 2000)
    return { status: 400, body: { error: "Enter 1–2000 characters." } };
  const text = b.text.trim();
  return serialize<RouteResponse>(key(c.number), async (): Promise<RouteResponse> => {
    let a = await ctx.kv.get<Appeal>(key(c.number));
    if (!a) {
      a = {
        case: c.number,
        userId: user,
        text,
        status: "pending",
        submittedAt: new Date().toISOString(),
      };
      await save(ctx, a);
    }
    if (a.status === "pending" && ctx.config.appeals?.via === "ticket" && !a.ticket) {
      if (!ctx.features.enabled("appealsViaTicket"))
        return { status: 503, body: { error: "Ticket integration requires its grant." } };
      const ticket = await ctx.plugins.call(
        "tickets",
        "open",
        {
          userId: user,
          caseNumber: c.number,
          subject: ctx.i18n.t("appeal.ticket", { number: c.number }),
          description: a.text,
        },
        { idempotencyKey: "appeal:" + c.number },
      );
      a.ticket = (ticket as { id: string }).id;
      await save(ctx, a);
    }
    if (ctx.config.appeals?.channel && !a.notified && a.status === "pending") {
      const target = ctx.config.appeals.channel;
      const audience = ctx.server.compareAudience(ctx.config.logChannel, target);
      if (audience === "same" || audience === "narrower") {
        a.notified = true;
        await save(ctx, a);
        await ctx.server.channel(target).send({
          content: ctx.i18n.t("appeal.submitted", { number: c.number }),
          allowedMentions: { users: false, roles: false, everyone: false },
        });
      }
    }
    await ctx.events.publish(
      "appeal",
      { case: c.number, userId: user, status: a.status },
      { idempotencyKey: "appeal:" + c.number + ":submitted" },
    );
    return { status: 200, body: a };
  });
}
export async function listAppeals(ctx: Context, r: RouteRequest): Promise<RouteResponse> {
  const p = await ctx.kv.list<Appeal>({ prefix: "appeal:", limit: 50, cursor: r.query.cursor });
  return { items: p.items.map((i) => i.value), next: p.cursor ?? null };
}
export async function decideAppeal(ctx: Context, r: RouteRequest): Promise<RouteResponse> {
  const n = safeNumber(r.params.id),
    staff = r.viewer?.member;
  if (!n || !staff || !["moderator", "admin"].includes(staff.access ?? "")) return { status: 403 };
  const status = (r.body as { decision?: string } | undefined)?.decision;
  if (status !== "accepted" && status !== "rejected")
    return { status: 400, body: { error: "Use accepted or rejected." } };
  return serialize<RouteResponse>(key(n), async () => {
    const a = await ctx.kv.get<Appeal>(key(n)),
      c = await readCase(ctx, n);
    if (!a || !c || !c.member || c.member.id !== a.userId) return { status: 404 };
    if (a.status !== "pending") {
      await finalizeDecision(ctx, a);
      return { status: 200, body: a };
    }
    let resolution = "no change";
    if (status === "accepted") {
      const actor = who(staff.user, staff.displayName),
        reason = "Appeal accepted for case #" + n;
      let lifted = false;
      if (c.status === "active") {
        if (c.action === "ban" || c.action === "tempban")
          lifted = await liftBanIfCurrent(ctx, c.member.id, n, actor, reason);
        else if (c.action === "quarantine")
          lifted = await release(ctx, c.member.id, n, actor, reason);
        else if (c.action === "warn") {
          const k = warnPrefix(c.member.id) + String(n).padStart(8, "0");
          if (await ctx.kv.get(k)) {
            await ctx.kv.delete(k);
            lifted = true;
          }
        } else if (c.action === "timeout") {
          const user = c.member.id;
          lifted = await serialize("timeout:" + user, async () => {
            const active = await ctx.kv.get<{ number: number; until: string }>("timeout:" + user);
            const m = await ctx.server.member(user);
            if (
              !active ||
              active.number !== n ||
              !m?.timedOutUntil ||
              m.timedOutUntil.toISOString() !== active.until ||
              +m.timedOutUntil <= Date.now()
            )
              return false;
            await m.timeout(0, reason);
            await ctx.kv.delete("timeout:" + user);
            return true;
          });
        }
      }
      resolution = lifted
        ? "case sanction lifted"
        : "sanction absent, expired, superseded or unverifiable";
      if (lifted) {
        const latest = await readCase(ctx, n);
        if (latest) await editCase(ctx, n, { status: "lifted" });
      }
    }
    Object.assign(a, { status, resolution, by: staff.id, decidedAt: new Date().toISOString() });
    await save(ctx, a);
    await finalizeDecision(ctx, a);
    return { status: 200, body: a };
  });
}

export async function renew(ctx: Context, r: RouteRequest): Promise<RouteResponse> {
  const c = await scopedCase(ctx, r);
  if (!c?.member) return { status: 403 };
  return serialize<RouteResponse>(key(c.number), async (): Promise<RouteResponse> => {
    const a = await ctx.kv.get<Appeal>(key(c.number));
    if (a && a.status !== "pending") return { status: 403 };
    const cooldown = "appeal-renew:" + c.number;
    if (await ctx.kv.get(cooldown))
      return { status: 429, body: { error: "A new link was recently requested." } };
    const url = await appealLink(ctx, c);
    await ctx.kv.set(cooldown, true, {
      ttlSeconds: (ctx.config.appeals?.cooldownDays ?? 7) * 86400,
    });
    // Reserve the cooldown before sending. An ambiguous network error cannot send
    // duplicate DMs if the browser retries.
    await ctx.server.sendDM(c.member!.id, ctx.i18n.t("appeal.renewed", { number: c.number, url }));
    return { status: 200, body: { sent: true } };
  });
}

async function finalizeDecision(ctx: Context, a: Appeal) {
  await ctx.events.publish(
    "appeal",
    { case: a.case, userId: a.userId, status: a.status },
    { idempotencyKey: "appeal:" + a.case + ":decided" },
  );
  if (enabled(ctx)) await ctx.portal.revoke({ kind: "case", id: String(a.case) });
}
