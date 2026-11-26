import type { Context, AuditLogEntry, PluginConfig } from "@cicord/sdk";
import { MONTH, rows, tr } from "./data.ts";

export type Trigger = keyof PluginConfig["thresholds"];
type Evidence = {
  id: string;
  time: number;
  actor: string;
  kind: string;
  certainty: string;
  merged: boolean;
};
type Pair = {
  trigger: Trigger;
  target: string;
  began: number;
  structure: boolean;
  evidence: Evidence[];
  done: boolean;
  alert?: string;
};
type Alert = {
  trigger: Trigger;
  at: number;
  actorId?: string;
  actorType: "bot" | "human" | "cicord" | "unknown";
  certainty: "confirmed" | "probable" | "unknown";
  count: number;
  why: string;
  staffMessage?: { channel: string; id: string };
};
const WAIT = 30000;
export function triggers(e: AuditLogEntry): Trigger[] {
  const direct: Record<string, Trigger> = {
    "channel.delete": "channelDelete",
    "role.delete": "roleDelete",
    "member.ban": "ban",
    "member.kick": "kick",
    "webhook.create": "webhookCreate",
    "bot.add": "botAdd",
  };
  const trigger = direct[e.action];
  if (trigger) return [trigger];
  if (e.action === "server.update") {
    const keys = e.changes.map((c) => c.key);
    return [
      ...(keys.includes("name") ? ["serverRename" as const] : []),
      ...(keys.includes("icon_hash") ? ["serverIcon" as const] : []),
      ...(keys.includes("vanity_url_code") ? ["vanityChange" as const] : []),
    ];
  }
  if (
    (e.action === "role.update" || e.action === "role.create") &&
    e.changes.some((c) =>
      c.addedPermissions?.some((p) =>
        [
          "Administrator",
          "ManageServer",
          "ManageRoles",
          "ManageChannels",
          "BanMembers",
          "KickMembers",
          "ManageWebhooks",
        ].includes(p),
      ),
    )
  )
    return ["dangerousPermissionGrant"];
  return [];
}
const keyFor = (trigger: Trigger, target: string) => "pair:" + trigger + ":" + target;
const notice = (ctx: Context, a: Alert) =>
  tr(ctx, "message.monitor") +
  a.trigger +
  " ×" +
  a.count +
  " • " +
  a.certainty +
  " • " +
  (a.actorId ?? tr(ctx, "message.unknownActor")) +
  "\n" +
  a.why +
  "\n" +
  tr(ctx, "message.staffReviewRecommendedRestoredChannelsReceive");
async function alert(ctx: Context, key: string, a: Alert) {
  const old = await ctx.kv.get<Alert>(key);
  await ctx.kv.set(key, a, { ttlSeconds: MONTH });
  await ctx.events.publish(
    "triggered",
    {
      trigger: a.trigger,
      count: a.count,
      actorType: a.actorType,
      certainty: a.certainty,
      responses: [],
      ...(a.actorId ? { actorId: a.actorId } : {}),
    },
    { idempotencyKey: key + (old ? ":updated" : ":new") },
  );
  try {
    if (old?.staffMessage) {
      const copy = await ctx.server
        .channel({ id: old.staffMessage.channel })
        .message(old.staffMessage.id);
      if (copy) {
        await copy.edit({
          content: notice(ctx, a),
          allowedMentions: { users: false, roles: false, everyone: false },
        });
        a.staffMessage = old.staffMessage;
      }
    }
    if (!a.staffMessage && ctx.config.staffChannel) {
      const channel = ctx.server.channel(ctx.config.staffChannel);
      const msg = await channel.send({
        content: notice(ctx, a),
        allowedMentions: { users: false, roles: false, everyone: false },
      });
      a.staffMessage = { channel: channel.id, id: msg.id };
      await ctx.kv.set(key, a, { ttlSeconds: MONTH });
      if (a.actorId) await ctx.schedule.after(MONTH * 1000, "redact", a.staffMessage);
    }
    if (!old && ctx.config.notifyOwner && ctx.features.enabled("ownerDM") && ctx.server.ownerId) {
      const owner = await ctx.server.member(ctx.server.ownerId);
      await owner?.send(tr(ctx, "message.antiNukeDetectedAnIncidentReview"));
    }
    if (
      !old &&
      ctx.config.notifyWebhook &&
      ctx.features.enabled("webhook") &&
      ctx.secrets.has("WEBHOOK_URL")
    ) {
      const response = await ctx.http.fetch(ctx.secrets.ref("WEBHOOK_URL"), {
        method: "POST",
        json: {
          content:
            tr(ctx, "message.antiNukeStaffReviewRequested") + " " + a.trigger + " ×" + a.count,
        },
        timeoutMs: 2000,
      });
      if (response.status < 200 || response.status >= 300)
        ctx.log.warn("anti-nuke webhook unavailable");
    }
    if (a.staffMessage) await ctx.kv.set(key, a, { ttlSeconds: MONTH });
  } catch {
    ctx.status.set("notifications", tr(ctx, "status.notificationDelivery"));
  }
}
async function trusted(ctx: Context, e: Evidence) {
  if (
    e.actor === ctx.server.ownerId ||
    (e.kind === "bot" ? ctx.config.trusted.bots : ctx.config.trusted.users).includes(e.actor)
  )
    return true;
  if (ctx.config.trustedFromCommand && (await ctx.kv.get("trust:" + e.actor))) return true;
  return ctx.config.trustAdmins && (await ctx.server.member(e.actor))?.access === "admin";
}
async function classify(ctx: Context, key: string, p: Pair) {
  const e = p.evidence[0];
  const now = Date.now();
  const conflict = new Set(p.evidence.map((a) => a.actor + "|" + a.kind)).size > 1;
  const certain =
    p.structure &&
    e &&
    !!e.actor &&
    e.certainty === "confirmed" &&
    !conflict &&
    p.evidence.every(
      (row) => !row.merged && row.certainty === "confirmed" && Math.abs(p.began - row.time) <= WAIT,
    );
  if (certain && e.kind === "cicord") return;
  const known = certain && (e.kind === "human" || e.kind === "bot");
  if (known && (await trusted(ctx, e))) return;
  const probable = !conflict && e?.kind === "cicord" && e.certainty === "probable";
  const actor = known ? e.actor : undefined;
  const group = "counter:" + (actor ?? "_unknown") + ":" + p.trigger,
    seconds = ctx.config.windowSeconds;
  const at = known ? e.time : p.began;
  const previous = (await ctx.kv.get<{ key: string; at: number }[]>(group)) ?? [];
  const latest = previous.reduce((last, x) => Math.max(last, x.at), at);
  const history = previous.filter((x) => latest - x.at < seconds * 1000);
  if (latest - at >= seconds * 1000) return;
  if (history.some((x) => x.key === key)) return;
  history.push({ key, at });
  await ctx.kv.set(group, history.slice(-100), { ttlSeconds: seconds });
  const raid = (await ctx.kv.get<boolean>("raid")) === true;
  const limit = Math.max(
    1,
    Math.ceil(
      ctx.config.thresholds[p.trigger] * (raid ? ctx.config.raidThresholdPercent / 100 : 1),
    ),
  );
  if (known && history.length !== limit) return;
  const why = known
    ? tr(ctx, "message.confirmedAuditEvidenceStaffMayReview")
    : probable
      ? tr(ctx, "message.possibleBotTokenCompromiseInspectThe")
      : tr(ctx, "message.missingDelayedMergedOrConflictingEvidence");
  const a: Alert = {
    trigger: p.trigger,
    at: now,
    count: history.length,
    actorType: known ? (e.kind as "human" | "bot") : probable ? "cicord" : "unknown",
    certainty: known ? "confirmed" : probable ? "probable" : "unknown",
    why,
    ...(actor ? { actorId: actor } : {}),
  };
  p.alert = "alert:" + p.began + ":" + key;
  await alert(ctx, p.alert, a);
}
async function pair(
  ctx: Context,
  trigger: Trigger,
  target: string,
  structure: boolean,
  e?: Evidence,
) {
  const key = keyFor(trigger, target),
    now = Date.now();
  const old = await ctx.kv.get<Pair>(key);
  const p: Pair = old ?? {
    trigger,
    target,
    began: now,
    structure: false,
    evidence: [],
    done: false,
  };
  if (p.done || (old && now - p.began > WAIT)) {
    // A late observation can annotate a staff alert but never retroactively names an actor.
    if (e && p.alert) {
      const a = await ctx.kv.get<Alert>(p.alert);
      if (a && (a.certainty !== "confirmed" || a.actorId !== e.actor)) {
        const revised: Alert = { ...a, actorType: "unknown", certainty: "unknown" };
        delete revised.actorId;
        await alert(ctx, p.alert, {
          ...revised,
          why: tr(ctx, "message.lateAuditEvidenceReceivedManualReview"),
        });
      }
    }
    return;
  }
  p.structure ||= structure;
  if (e && !p.evidence.some((x) => x.id === e.id)) p.evidence.push(e);
  await ctx.kv.set(key, p, { ttlSeconds: 600 });
  if (!old) await ctx.schedule.after(WAIT, "settle", { key });
}
export async function settle(ctx: Context, key: string) {
  const p = await ctx.kv.get<Pair>(key);
  if (!p || p.done) return;
  if (Date.now() - p.began < WAIT) {
    await ctx.schedule.after(WAIT - (Date.now() - p.began), "settle", { key });
    return;
  }
  await classify(ctx, key, p);
  p.done = true;
  await ctx.kv.set(key, p, { ttlSeconds: 600 });
}
export async function structure(ctx: Context, trigger: Trigger, id: string) {
  await pair(ctx, trigger, id, true);
}
export async function audit(ctx: Context, entry: AuditLogEntry) {
  const kinds = triggers(entry);
  if (!kinds.length) return;
  if (await ctx.kv.get("audit:" + entry.id)) return;
  const e: Evidence = {
    id: entry.id,
    time: entry.at.getTime(),
    actor: entry.actorId ?? entry.actor?.id ?? "",
    kind: entry.attribution.kind,
    certainty: entry.attribution.certainty,
    merged: entry.mergeable,
  };
  for (const trigger of kinds) {
    if ((trigger === "channelDelete" || trigger === "roleDelete") && entry.targetId)
      await pair(ctx, trigger, entry.targetId, false, e);
    else {
      const key = "observation:" + trigger + ":" + entry.id;
      await classify(ctx, key, {
        trigger,
        began: Date.now(),
        target: "",
        structure: !!entry.targetId,
        evidence: [e],
        done: false,
      });
    }
  }
  await ctx.kv.set("audit:" + entry.id, true, { ttlSeconds: 600 });
}
export async function memberData(ctx: Context, id: string, erase: boolean) {
  const result: Record<string, import("@cicord/sdk").Json> = {};
  let erased = 0;
  for (const r of await rows<Alert>(ctx, "alert:")) {
    if (r.value.actorId !== id) continue;
    result[r.key] = r.value;
    if (erase) {
      if (r.value.staffMessage) {
        const s = r.value.staffMessage;
        const msg = await ctx.server.channel({ id: s.channel }).message(s.id);
        if (msg) await msg.edit(tr(ctx, "message.incidentRecordErased"));
      }
      await ctx.kv.delete(r.key);
      erased++;
    }
  }
  for (const r of await rows<Pair>(ctx, "pair:")) {
    const owned = r.value.evidence.filter((e) => e.actor === id);
    if (!owned.length) continue;
    result[r.key] = owned;
    if (erase) {
      const remaining = r.value.evidence.filter((e) => e.actor !== id);
      await ctx.kv.set(r.key, { ...r.value, evidence: remaining }, { ttlSeconds: 600 });
      erased++;
    }
  }
  const trust = await ctx.kv.get("trust:" + id);
  if (trust !== undefined) {
    result.trusted = trust;
    if (erase) {
      await ctx.kv.delete("trust:" + id);
      erased++;
    }
  }
  for (const r of await rows(ctx, "counter:" + id + ":")) {
    result[r.key] = r.value;
    if (erase) {
      await ctx.kv.delete(r.key);
      erased++;
    }
  }
  return { result, erased };
}
