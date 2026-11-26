import {
  InteropError,
  command,
  definePlugin,
  subcommand,
  type Context,
  type Member,
  type Json,
  type Interaction,
  type RouteResponse,
} from "@cicord/sdk";
import { begin, check, methodFor } from "./challenge.ts";
import { MONTH, object, serial, staff, tr } from "./data.ts";

type Result = { result: "passed" | "denied" | "kicked"; method: string; at: string };
type Pending = {
  state: "pending" | "hold" | "delay";
  joined: number;
  deadline: number;
  retry: number;
};
const DENIED = { status: 403, body: { error: "forbidden" } };
const date = () => new Date().toISOString();
const portalPath = (ctx: Context, path: string) =>
  "/verification/" +
  path +
  "?bot=" +
  encodeURIComponent(ctx.bot.key) +
  "&instance=" +
  encodeURIComponent(ctx.plugin.instance);
const age = (member: Member) => member.user.createdAt?.getTime();
function young(ctx: Context, member: Member) {
  const created = age(member);
  return (
    Number.isFinite(created) &&
    Date.now() >= created! &&
    Date.now() - created! < ctx.config.minAccountAgeDays * 86400000
  );
}
async function pending(ctx: Context, member: Member): Promise<Pending> {
  const joined = member.joinedAt?.getTime() || 0;
  const old = await ctx.kv.get<Pending>("pending:" + member.id);
  if (old && old.joined === joined) return old;
  const record: Pending = {
    state: "pending",
    joined,
    deadline:
      ctx.config.kickAfterHours && joined ? joined + ctx.config.kickAfterHours * 3600000 : 0,
    retry: 0,
  };
  await ctx.kv.set("pending:" + member.id, record, { ttlSeconds: MONTH });
  return record;
}
type Grant = { joined: number; role: string; result: Result };
async function deliver(ctx: Context, id: string) {
  const key = "outbox:" + id;
  const event = await ctx.kv.getEntry<Result>(key);
  if (!event) return;
  const result = event.value,
    passed = result.result === "passed";
  await ctx.events.publish(
    passed ? "passed" : "failed",
    { userId: id, method: result.method, ...(passed ? {} : { reason: result.result }) },
    {
      idempotencyKey: id + ":" + result.result + ":" + result.at,
    },
  );
  await ctx.kv.atomic().check(key, event.version).delete(key).commit();
}
async function publish(ctx: Context, id: string, result: Result) {
  await ctx.kv
    .atomic()
    .set("result:" + id, result, { ttlSeconds: MONTH })
    .set("outbox:" + id, result, { ttlSeconds: MONTH })
    .delete("grant:" + id)
    .delete("pending:" + id)
    .delete("challenge:" + id)
    .commit();
  await deliver(ctx, id);
}
async function completeGrant(ctx: Context, member: Member, grant: Grant) {
  if (member.joinedAt.getTime() !== grant.joined || ctx.config.verifiedRole !== grant.role) {
    await ctx.kv.delete("grant:" + member.id);
    return;
  }
  if (!member.hasRole(grant.role)) await member.addRole(grant.role, "verification");
  await publish(ctx, member.id, grant.result);
}
async function approve(ctx: Context, member: Member, method: string) {
  const grant: Grant = {
    joined: member.joinedAt.getTime(),
    role: ctx.config.verifiedRole,
    result: { result: "passed", method, at: date() },
  };
  await ctx.kv.set("grant:" + member.id, grant, { ttlSeconds: 86400 });
  await completeGrant(ctx, member, grant);
  return { verified: true };
}
async function status(
  ctx: Context,
  id: string,
): Promise<{ verified: boolean; method?: string; at?: string }> {
  const member = await ctx.server.member(id);
  if (!member || !member.hasRole(ctx.config.verifiedRole)) return { verified: false };
  const result = await ctx.kv.get<Result>("result:" + id);
  return result?.result === "passed"
    ? { verified: true, method: result.method, at: result.at }
    : { verified: true };
}
type Recovery = { caseId: string; retryAt: number };
const HOUR = 3600000;
/** The grant a kick needs and lacks, if any: moderation's sanction when it is installed. */
function missingKickGrant(ctx: Context) {
  const delegated = ctx.plugins.has("moderation");
  if (ctx.features.enabled(delegated ? "sanctions" : "directKick")) return undefined;
  return delegated ? "plugins.call:moderation.sanction" : "discord.members.moderate";
}
const kicks = (ctx: Context) => ctx.config.youngAccount === "kick" || ctx.config.kickAfterHours > 0;
// A delayed member keeps the full expiry window after their retry time.
function deadlineOf(ctx: Context, p: Pending) {
  if (!ctx.config.kickAfterHours) return 0;
  return p.state === "delay"
    ? Math.max(p.deadline, p.retry + ctx.config.kickAfterHours * HOUR)
    : p.deadline;
}
/** Returns false when the kick cannot be delegated or applied with the current grants. */
async function kick(ctx: Context, member: Member, reason: string): Promise<boolean> {
  if (
    !member.access ||
    staff(member) ||
    member.id === ctx.server.ownerId ||
    member.user.bot ||
    member.hasRole(ctx.config.verifiedRole)
  )
    return true;
  const grant = missingKickGrant(ctx);
  if (grant) {
    ctx.status.set("kick", ctx.i18n.t("status.kickGrant", { grant }));
    return false;
  }
  const delegated = ctx.plugins.has("moderation");
  const caseId = member.id + "-" + member.joinedAt.getTime();
  const earlier = await ctx.kv.get<Recovery>("recovery:" + member.id);
  if (earlier && earlier.caseId !== caseId)
    await ctx.portal.revoke({ kind: "case", id: earlier.caseId });
  const retryAt = Math.max(
    Date.now(),
    (age(member) || Date.now()) + ctx.config.minAccountAgeDays * 86400000,
  );
  const ttl = Math.min(604800, Math.ceil((retryAt - Date.now()) / 1000) + 86400);
  // The notice is a courtesy: closed DMs or a missing DM grant never block the kick.
  if (ctx.features.enabled("dm"))
    try {
      const url = await ctx.portal.link(portalPath(ctx, "return/" + caseId), {
        user: member.user,
        scope: { kind: "case", id: caseId },
        expiresInSeconds: ttl,
      });
      await member.send({
        content:
          tr(ctx, "message.youCanRejoinAfter") + new Date(retryAt).toISOString() + "\n" + url,
      });
    } catch {
      ctx.log.info("Verification kick notice undeliverable", { reason });
    }
  if (delegated)
    await ctx.plugins.call(
      "moderation",
      "sanction",
      { userId: member.id, action: "kick", reason },
      { idempotencyKey: "verification:" + member.id + ":" + member.joinedAt.getTime() },
    );
  else await member.kick(reason);
  await ctx.kv.set("recovery:" + member.id, { caseId, retryAt }, { ttlSeconds: ttl });
  await publish(ctx, member.id, { result: "kicked", method: reason, at: date() });
  return true;
}
// Three failures lock the challenge for 15 minutes. Six within a day send the member
// to the staff queue, so blind guessing cannot be repeated indefinitely.
const FAILURES = 3,
  LOCK_SECONDS = 900,
  STRIKES = 6;
async function hold(ctx: Context, member: Member, r: Pending, method: string, reason: string) {
  r.state = "hold";
  r.retry = 0;
  await ctx.kv.set("pending:" + member.id, r, { ttlSeconds: MONTH });
  await ctx.events.publish("failed", { userId: member.id, method, reason });
  return { state: r.state, retryAt: r.retry };
}
async function submit(
  ctx: Context,
  member: Member,
  body: Json | undefined,
): Promise<RouteResponse> {
  if (member.hasRole(ctx.config.verifiedRole))
    return { status: 409, body: { error: "already_verified" } };
  const r = await pending(ctx, member);
  if (r.state === "hold" || (r.state === "delay" && r.retry > Date.now()))
    return { state: r.state, retryAt: r.retry };
  const failures = (await ctx.kv.get<number>("attempts:" + member.id)) ?? 0;
  if (failures >= FAILURES) return { status: 429, body: { error: "try_later" } };
  let method;
  try {
    method = await check(ctx, member, object(body));
  } catch {
    return { status: 503, body: { error: "challenge_unavailable" } };
  }
  if (!method) {
    const strikes = ((await ctx.kv.get<number>("strikes:" + member.id)) ?? 0) + 1;
    await ctx.kv.set("attempts:" + member.id, failures + 1, { ttlSeconds: LOCK_SECONDS });
    await ctx.kv.set("strikes:" + member.id, strikes, { ttlSeconds: 86400 });
    if (strikes >= STRIKES) return hold(ctx, member, r, methodFor(ctx, member), "attempts");
    await ctx.events.publish("failed", {
      userId: member.id,
      method: methodFor(ctx, member),
      reason: "challenge",
    });
    return { status: 422, body: { error: "challenge_failed" } };
  }
  if (young(ctx, member)) {
    if (ctx.config.youngAccount === "kick") {
      if (await kick(ctx, member, "age")) return { verified: false };
      // Without the sanction grant, staff decide instead of the member being admitted.
      return hold(ctx, member, r, method, "age");
    }
    r.state = ctx.config.youngAccount;
    r.retry = r.state === "delay" ? Date.now() + ctx.config.delayHours * HOUR : 0;
    r.deadline = deadlineOf(ctx, r);
    await ctx.kv.set("pending:" + member.id, r, { ttlSeconds: MONTH });
    await ctx.events.publish("failed", { userId: member.id, method, reason: "age" });
    return { state: r.state, retryAt: r.retry };
  }
  return approve(ctx, member, method);
}
async function decide(ctx: Context, id: string, decision: unknown): Promise<RouteResponse> {
  return serial<RouteResponse>(ctx, id, async () => {
    const member = await ctx.server.member(id);
    const record = await ctx.kv.get<Pending>("pending:" + id);
    if (
      !member ||
      !record ||
      record.state !== "hold" ||
      member.joinedAt.getTime() !== record.joined
    )
      return { status: 404, body: { error: "no_pending_review" } };
    if (decision === "approve") return approve(ctx, member, "staff");
    if (decision !== "deny") return { status: 400, body: { error: "invalid_decision" } };
    await publish(ctx, id, { result: "denied", method: "staff", at: date() });
    return { verified: false };
  });
}
async function memberLink(ctx: Context, i: Interaction) {
  if (!i.member) return;
  const url = await ctx.portal.link(portalPath(ctx, "challenge"), { member: i.member });
  await i.reply({
    ephemeral: true,
    components: [
      {
        type: "row",
        components: [{ type: "link", label: tr(ctx, "message.openChallenge"), url }],
      },
    ],
  });
}
async function reviewCommand(
  ctx: Context,
  i: Interaction,
  id: string,
  decision: "approve" | "deny",
) {
  if (!staff(i.member)) {
    await i.reply(tr(ctx, "message.staffOnly"));
    return;
  }
  const result = await decide(ctx, id, decision);
  const ok =
    typeof result === "object" && result !== null && !Array.isArray(result) && "verified" in result;
  await i.reply(
    tr(ctx, ok ? (decision === "approve" ? "review.approved" : "review.denied") : "review.missing"),
  );
}
const target = { user: { type: "user", description: "Member", required: true } } as const;
const prefixes = [
  "result:",
  "pending:",
  "challenge:",
  "attempts:",
  "strikes:",
  "recovery:",
  "lock:",
  "grant:",
  "outbox:",
];
export default definePlugin({
  onStart(ctx) {
    const served = methodFor(ctx);
    if (served === "review")
      ctx.status.set("challenge", tr(ctx, "status.challengeReview"));
    else if (served !== ctx.config.method)
      ctx.status.set("challenge", tr(ctx, "message.challengeFallbackIsActiveCheckOptional"));
    else ctx.status.set("challenge", null);
    const grant = kicks(ctx) ? missingKickGrant(ctx) : undefined;
    ctx.status.set("kick", grant ? ctx.i18n.t("status.kickGrant", { grant }) : null);
    ctx.status.set(
      "kickNotice",
      kicks(ctx) && !ctx.features.enabled("dm") ? tr(ctx, "status.kickNotice") : null,
    );
  },
  events: {
    async memberJoin(ctx, member) {
      if (member.user.bot || member.hasRole(ctx.config.verifiedRole)) return;
      await pending(ctx, member);
      if (ctx.config.dmOnJoin && ctx.features.enabled("dm"))
        await member.send(
          tr(ctx, "message.verifyYourMembershipHere") +
            (await ctx.portal.link(portalPath(ctx, "challenge"), { member })),
        );
    },
  },
  schedules: {
    delivery: {
      cron: "* * * * *",
      async run(ctx) {
        for (const { key, value } of (await ctx.kv.list<Grant>({ prefix: "grant:", limit: 50 }))
          .items) {
          const id = key.slice(6);
          await serial(ctx, id, async () => {
            const current = await ctx.kv.get<Grant>(key);
            if (!current || current.result.at !== value.result.at) return;
            const member = await ctx.server.member(id);
            if (member) await completeGrant(ctx, member, current);
            else await ctx.kv.delete(key);
          });
        }
        for (const { key } of (await ctx.kv.list({ prefix: "outbox:", limit: 50 })).items)
          await deliver(ctx, key.slice(7));
      },
    },
    expiry: {
      cron: "*/5 * * * *",
      async run(ctx) {
        if (!ctx.config.kickAfterHours) return;
        const cursor = await ctx.kv.get<string>("expiryCursor");
        const page = await ctx.kv.list<Pending>({ prefix: "pending:", limit: 100, cursor });
        let failed = 0;
        for (const { key, value } of page.items) {
          const deadline = deadlineOf(ctx, value);
          if (value.state === "hold" || !deadline || deadline > Date.now()) continue;
          const id = key.slice(8);
          // One member's failure must not stall the cursor for everyone after them.
          try {
            await serial(ctx, id, async () => {
              const member = await ctx.server.member(id);
              if (member && member.joinedAt.getTime() === value.joined)
                await kick(ctx, member, "expired");
              else await ctx.kv.delete(key);
            });
          } catch (error) {
            failed++;
            ctx.log.warn("Verification expiry kick failed", { error: String(error) });
          }
        }
        if (failed) ctx.status.set("expiry", ctx.i18n.t("status.expiryFailed", { count: failed }));
        else if (!page.cursor) ctx.status.set("expiry", null);
        if (page.cursor) await ctx.kv.set("expiryCursor", page.cursor, { ttlSeconds: 86400 });
        else await ctx.kv.delete("expiryCursor");
      },
    },
  },
  queries: {
    status: {
      async run(ctx, input: { userId: string }, call) {
        const viewer = call.onBehalfOf;
        if (
          viewer?.access === "scoped" ||
          (viewer?.access === "member" && viewer.userId !== input.userId)
        )
          throw new InteropError("denied", "Verification status requires access to this member.");
        const result = await status(ctx, input.userId);
        return call.onBehalfOf ? result : { verified: result.verified };
      },
    },
  },
  routes: {
    "GET /challenge": {
      access: "member",
      async handler(ctx, r): Promise<RouteResponse> {
        if (!r.viewer?.member) return DENIED;
        const member = r.viewer.member;
        if (member.hasRole(ctx.config.verifiedRole)) return { verified: true };
        if ((await ctx.kv.get<Result>("result:" + member.id))?.result === "denied")
          return { state: "denied" };
        const p = await pending(ctx, member);
        if (p.state === "hold" || (p.state === "delay" && p.retry > Date.now()))
          return { state: p.state, retryAt: p.retry };
        // No challenge can be served (fallback: review): staff decide, never a silent pass.
        return (await begin(ctx, member)) ?? hold(ctx, member, p, ctx.config.method, "unavailable");
      },
    },
    "POST /challenge": {
      access: "member",
      async handler(ctx, r): Promise<RouteResponse> {
        const m = r.viewer?.member;
        if (!m) return DENIED;
        return serial(ctx, m.id, async () =>
          (await ctx.kv.get<Result>("result:" + m.id))?.result === "denied"
            ? DENIED
            : submit(ctx, m, r.body),
        );
      },
    },
    "GET /queue": {
      access: "moderator",
      async handler(ctx, r): Promise<RouteResponse> {
        if (!staff(r.viewer?.member)) return DENIED;
        const p = await ctx.kv.list<Pending>({
          prefix: "pending:",
          cursor: r.query.cursor,
          limit: 100,
        });
        return {
          items: p.items
            .filter((row) => row.value.state === "hold")
            .map((row) => ({ userId: row.key.slice(8), joined: row.value.joined })),
          cursor: p.cursor ?? null,
        };
      },
    },
    "POST /queue/:id": {
      access: "moderator",
      async handler(ctx, r): Promise<RouteResponse> {
        if (!staff(r.viewer?.member)) return DENIED;
        return decide(ctx, r.params.id!, object(r.body).decision);
      },
    },
    "GET /return/:id": {
      access: "scoped",
      async handler(ctx, r): Promise<RouteResponse> {
        if (r.scope?.kind !== "case" || r.scope.id !== r.params.id || !r.viewer) return DENIED;
        const recovery = await ctx.kv.get<Recovery>("recovery:" + r.viewer.user.id);
        if (recovery?.caseId !== r.scope.id) return DENIED;
        const record = await ctx.kv.get<Result>("result:" + r.viewer.user.id);
        return {
          retryAt: recovery.retryAt,
          ...(ctx.config.returnInvite && Date.now() >= recovery.retryAt
            ? { invite: ctx.config.returnInvite }
            : {}),
          result: record?.result ?? "expired",
          method: record?.method ?? null,
          at: record?.at ?? null,
        };
      },
    },
  },
  commands: {
    "verify-panel": command({
      description: "Publish verification panel",
      permissions: ["ManageServer"],
      async run(ctx, i) {
        if (!staff(i.member)) {
          await i.reply({
            ephemeral: true,
            content: tr(ctx, "message.staffOnly"),
          });
          return;
        }
        const channel = ctx.server.channel(ctx.config.panelChannel);
        const payload = {
          content: tr(ctx, "message.verifyToAccessTheServer"),
          components: [
            {
              type: "row" as const,
              components: [
                { type: "button" as const, id: "verify", label: tr(ctx, "message.verify") },
              ],
            },
          ],
        };
        const old = await ctx.kv.get<string>("panel");
        const msg = old ? await channel.message(old) : undefined;
        if (msg) await msg.edit(payload);
        else await ctx.kv.set("panel", (await channel.send(payload)).id);
        await i.reply({ ephemeral: true, content: tr(ctx, "message.panelReady") });
      },
    }),
    verify: command({
      description: "Review verification",
      ephemeral: true,
      subcommands: {
        approve: subcommand({
          description: "Approve a held member",
          options: target,
          async run(ctx, i) {
            await reviewCommand(ctx, i, i.options.user.id, "approve");
          },
        }),
        deny: subcommand({
          description: "Deny a held member",
          options: target,
          async run(ctx, i) {
            await reviewCommand(ctx, i, i.options.user.id, "deny");
          },
        }),
        status: subcommand({
          description: "Verification status",
          options: target,
          async run(ctx, i) {
            if (i.user.id !== i.options.user.id && !staff(i.member)) {
              await i.reply(tr(ctx, "message.staffOnly"));
              return;
            }
            const result = await status(ctx, i.options.user.id);
            await i.reply(
              tr(ctx, result.verified ? "status.verified" : "status.pending") +
                (result.at ? " " + result.at : ""),
            );
          },
        }),
      },
    }),
  },
  components: { verify: memberLink },
  privacy: {
    async export(ctx, id) {
      const record: Record<string, Json> = {};
      for (const p of prefixes) {
        const v = await ctx.kv.get(p + id);
        if (v !== undefined)
          record[p.slice(0, -1)] = p === "challenge:" || p === "lock:" ? { active: true } : v;
      }
      return record;
    },
    async erase(ctx, id) {
      const recovery = await ctx.kv.get<Recovery>("recovery:" + id);
      if (recovery) await ctx.portal.revoke({ kind: "case", id: recovery.caseId });
      let erased = 0;
      for (const p of prefixes) {
        if ((await ctx.kv.get(p + id)) !== undefined) {
          await ctx.kv.delete(p + id);
          erased++;
        }
      }
      return { erased };
    },
  },
});
