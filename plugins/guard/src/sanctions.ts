import type { Context, Member } from "@cicord/sdk";
import { MONTH, tr } from "./data.ts";
import type { Action, Ref, Rule } from "./rules.ts";
type Violation = {
  at: number;
  rule: Rule;
  action: string;
  status?: "completed" | "needs_review";
  channelId: string;
  messageId?: string;
};

export async function sanction(
  ctx: Context,
  member: Member,
  action: Action,
  reason: string,
  key: string,
) {
  if (action.type === "delete") return;
  if (ctx.plugins.has("moderation")) {
    if (!ctx.features.enabled("sanctions")) throw new Error("moderation.sanction grant required");
    await ctx.plugins.call(
      "moderation",
      "sanction",
      {
        userId: member.id,
        action: action.type,
        reason,
        ...(action.type === "timeout" || action.type === "quarantine"
          ? { durationMinutes: action.minutes }
          : {}),
      },
      { idempotencyKey: key },
    );
    return;
  }
  if (action.type === "warn") return; // The guard violation record is the local warning.
  if (action.type === "quarantine") {
    if (!ctx.features.enabled("directQuarantine") || !ctx.config.quarantineRole)
      throw new Error("configure the quarantine role and grant or install moderation");
    if (!member.hasRole(ctx.config.quarantineRole))
      await member.addRole(ctx.config.quarantineRole, reason);
    return;
  }
  if (!ctx.features.enabled("directSanctions"))
    throw new Error("grant required for direct member action");
  if (action.type === "timeout") await member.timeout(action.minutes * 60000, reason);
  if (action.type === "kick") await member.kick(reason);
  if (action.type === "ban") await member.ban({ reason });
}
export async function record(
  ctx: Context,
  m: Member,
  rule: Rule,
  channelId: string,
  refs: Ref[],
  origin: string,
) {
  const key = "violations:" + m.id,
    now = Date.now();
  const list = ((await ctx.kv.get<Violation[]>(key)) ?? []).filter(
    (x) => x.at >= now - MONTH * 1000,
  );
  if (refs[0] && list.some((x) => x.messageId === refs[0]!.id)) return;
  const repeat = ctx.config.repeat;
  const count = list.filter((x) => now - x.at < repeat.withinMinutes * 60000).length;
  const action =
    repeat.enabled && count + 1 >= repeat.count ? repeat.action : ctx.config[rule].action;
  const event = {
    rule,
    channelId,
    action: ctx.config.mode === "monitor" ? "monitor" : action.type,
    ...(refs[0] ? { messageId: refs[0].id } : {}),
  };
  let outcome: "completed" | "needs_review" = "completed";
  try {
    if (ctx.config.mode === "enforce") {
      if ((rule === "duplicates" || action.type === "delete") && refs.length) {
        if (!ctx.features.enabled("removeMessages"))
          throw new Error("message removal grant required");
        for (const ref of refs) {
          const msg = await ctx.server.channel({ id: ref.channel }).message(ref.id);
          if (msg?.author.id === m.id) await msg.delete("guard " + rule);
        }
      }
      let alreadyQuarantined = false;
      if (
        action.type === "quarantine" &&
        ctx.features.enabled("standing") &&
        ctx.plugins.has("moderation")
      ) {
        const standing = await ctx.plugins.query("moderation", "standing", { userId: m.id });
        alreadyQuarantined =
          !!standing &&
          typeof standing === "object" &&
          !Array.isArray(standing) &&
          standing.quarantined === true;
      }
      if (!alreadyQuarantined)
        await sanction(ctx, m, action, "guard " + rule, "guard:" + rule + ":" + origin);
    }
  } catch {
    // The provider may already have acted. Staff retain the finding and inspect the
    // failure; a direct retry here could apply a second sanction.
    outcome = "needs_review";
    ctx.status.set("action", tr(ctx, "message.aGuardActionRequiresStaffReview"));
  }
  await ctx.kv.set(key, [...list.slice(-99), { ...event, status: outcome, at: now }], {
    ttlSeconds: MONTH,
  });
  const reported =
    outcome === "needs_review"
      ? { ...event, action: "needs_review", requestedAction: action.type }
      : event;
  await ctx.events.publish(
    "violation",
    { ...reported, userId: m.id },
    { idempotencyKey: rule + ":" + origin },
  );
  if (ctx.config.staffChannel)
    await ctx.server
      .channel(ctx.config.staffChannel)
      .send(tr(ctx, "message.guardDetected") + rule + " (" + reported.action + ").");
}
