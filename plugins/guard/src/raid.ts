import type { Context, Member, ComponentInteraction, OverwritePatch } from "@cicord/sdk";
import { MONTH, staff, tr } from "./data.ts";
import { exempt, recently } from "./rules.ts";
import { sanction } from "./sanctions.ts";

type Join = { id: string; at: number; young: boolean };
type Measure = "overlay" | "invites";
type Raid = {
  started: number;
  until: number;
  rate: number;
  enforced: boolean;
  phase?: "pending" | "active" | "closing";
  pending?: Measure[];
  invitesUntil?: number;
  wake?: string;
  alertNonce?: string;
  announced?: boolean;
  alerted?: boolean;
};
const RETRY_MS = 5000;
const readRaid = (ctx: Context) => ctx.kv.get<Raid>("raid");
const saveRaid = (ctx: Context, r: Raid) => ctx.kv.set("raid", r);
export const joins = async (ctx: Context) =>
  ((await ctx.kv.get<Join[]>("joins")) ?? []).filter(
    (x) => x.at >= Date.now() - ctx.config.raid.seconds * 1000,
  );

async function applyOverlay(ctx: Context, until: number) {
  if (!ctx.features.enabled("raidOverlay")) throw new Error("raidOverlay grant required");
  const config = ctx.config.raid.measures;
  const channels: Record<
    string,
    { slowmodeSeconds?: number; overwrites?: Record<string, OverwritePatch> }
  > = {};
  for (const c of config.slowmode.channels)
    channels[c] = { slowmodeSeconds: config.slowmode.seconds };
  for (const c of config.lockChannels)
    channels[c] = { ...channels[c], overwrites: { "@everyone": { deny: ["SendMessages"] } } };
  await ctx.server.overlays.apply({
    id: "raid",
    until: new Date(until),
    reason: "guard raid",
    server: { verificationLevel: config.verificationLevel },
    channels,
  });
}

// Schedule first. Once the desired state is visible it always has a recoverable wakeup.
async function arm(ctx: Context, r: Raid, at: number, executing?: string) {
  const old = r.wake;
  const task = await ctx.schedule.after(Math.max(1, at - Date.now()), "reconcileRaid", {
    started: r.started,
  });
  r.wake = task.id;
  r.alertNonce ??= task.id.slice(0, 25);
  await saveRaid(ctx, r);
  if (old && old !== executing) await ctx.schedule.cancel(old);
}

async function announce(ctx: Context, r: Raid) {
  if (!r.announced) {
    const measures = r.enforced
      ? [
          "verificationLevel",
          ...(ctx.config.raid.measures.slowmode.channels.length ? ["slowmode"] : []),
          ...(ctx.config.raid.measures.lockChannels.length ? ["lock"] : []),
          ...(r.invitesUntil ? ["pauseInvites"] : []),
        ]
      : [];
    await ctx.events.publish(
      "raid",
      { state: "started", joinsPerMinute: r.rate, measures },
      { idempotencyKey: "start:" + r.started },
    );
    r.announced = true;
    await saveRaid(ctx, r);
  }
  if (r.alerted) return;
  if (ctx.config.staffChannel) {
    await ctx.server.channel(ctx.config.staffChannel).send({
      content: tr(ctx, "message.joinSurgeDetected") + " (" + ctx.config.mode + ")",
      nonce: r.alertNonce,
      enforceNonce: true,
      components: [
        {
          type: "row",
          components: [
            { type: "button", id: "lift:" + r.started, label: tr(ctx, "message.lift") },
            { type: "button", id: "extend:" + r.started, label: tr(ctx, "message.extend") },
            { type: "button", id: "review:" + r.started, label: tr(ctx, "message.reviewArrivals") },
          ],
        },
      ],
    });
  }
  r.alerted = true;
  await saveRaid(ctx, r);
}

async function settle(ctx: Context, r: Raid) {
  let noticePending = false;
  try {
    await announce(ctx, r);
  } catch {
    noticePending = true;
  }
  try {
    for (const measure of [...(r.pending ?? [])]) {
      if (measure === "overlay") await applyOverlay(ctx, r.until);
      else if (r.invitesUntil && r.invitesUntil > Date.now()) {
        if (!ctx.features.enabled("pauseInvites")) throw new Error("pauseInvites grant required");
        await ctx.server.incident({ invitesDisabledUntil: new Date(r.invitesUntil) });
      }
      r.pending = r.pending!.filter((m) => m !== measure);
      await saveRaid(ctx, r);
    }
  } catch {
    ctx.status.set("raid", tr(ctx, "status.raidPending"));
    return;
  }
  r.phase = "active";
  if (noticePending) {
    ctx.status.set("raid", tr(ctx, "status.raidNoticePending"));
    await saveRaid(ctx, r);
    return;
  }
  ctx.status.set("raid", null);
  await arm(ctx, r, r.until);
}

export async function open(ctx: Context, rate: number) {
  const previous = await readRaid(ctx),
    now = Date.now();
  if (previous?.phase === "closing") return "closing";
  const until = now + ctx.config.raid.calmMinutes * 60000,
    enforced = ctx.config.mode === "enforce";
  const config = ctx.config.raid.measures;
  const pause = enforced && ctx.features.enabled("pauseInvites");
  const pauseMs =
    parseInt(config.pauseInvites, 10) * (config.pauseInvites.endsWith("h") ? 3600000 : 60000);
  const started =
    previous?.started ?? Math.max(now, ((await ctx.kv.get<number>("raid:last-started")) ?? 0) + 1);
  if (!previous) await ctx.kv.set("raid:last-started", started);
  const r: Raid = {
    ...previous,
    started,
    until,
    rate,
    enforced,
    phase: "pending",
    pending: enforced ? ["overlay", ...(pause ? ["invites" as const] : [])] : [],
    invitesUntil: pause ? Math.min(until, now + pauseMs) : undefined,
    // Previously published versions did not persist announcement receipts.
    announced: previous?.announced ?? !!previous,
    alerted: previous?.alerted ?? !!previous,
  };
  await arm(ctx, r, Math.min(until, now + RETRY_MS));
  await settle(ctx, r);
  return r.phase;
}

async function finishClose(ctx: Context, r: Raid) {
  try {
    if (r.enforced) await ctx.server.overlays.remove("raid");
    await ctx.events.publish(
      "raid",
      { state: "ended", joinsPerMinute: r.rate, measures: [] },
      { idempotencyKey: "end:" + r.started },
    );
  } catch {
    ctx.status.set("raid", tr(ctx, "status.raidClosing"));
    return false;
  }
  // Direct Discord incident settings expire at their own recorded deadline.
  await ctx.kv
    .atomic()
    .set(
      "raidHistory:" + r.started,
      { started: r.started, ended: Date.now(), rate: r.rate, enforced: r.enforced },
      { ttlSeconds: MONTH },
    )
    .delete("raid")
    .delete("arrivals")
    .commit();
  ctx.status.set("raid", null);
  if (r.wake) await ctx.schedule.cancel(r.wake);
  return true;
}
export async function close(ctx: Context) {
  const r = await readRaid(ctx);
  if (!r) return true;
  r.phase = "closing";
  await arm(ctx, r, Date.now() + RETRY_MS);
  return finishClose(ctx, r);
}
export async function reconcileRaid(ctx: Context, started: number, wake: string) {
  const r = await readRaid(ctx);
  if (!r || r.started !== started || r.wake !== wake) return;
  if (
    r.phase === "closing" ||
    r.until <= Date.now() ||
    (r.enforced && ctx.config.mode !== "enforce")
  ) {
    r.phase = "closing";
    await arm(ctx, r, Date.now() + RETRY_MS, wake);
    await finishClose(ctx, r);
    return;
  }
  // Reserve the next attempt before doing any Discord IO. A crashed handler,
  // a paused runtime and a failed incident each retain the desired deadline.
  await arm(ctx, r, Math.min(r.until, Date.now() + RETRY_MS), wake);
  await settle(ctx, r);
}

export async function publicRaid(ctx: Context) {
  const r = await readRaid(ctx);
  return r
    ? {
        started: r.started,
        until: r.until,
        rate: r.rate,
        enforced: r.enforced,
        phase: r.phase ?? "active",
        pending: r.pending ?? [],
      }
    : null;
}
export async function onJoin(ctx: Context, m: Member) {
  if (exempt(ctx, m)) return;
  const window = await joins(ctx),
    now = Date.now();
  if (window.some((x) => x.id === m.id)) return;
  const next = [
    ...window.slice(-999),
    {
      id: m.id,
      at: now,
      young: recently(m.user.createdAt, ctx.config.newAccounts.minAccountAgeDays * 86400000),
    },
  ];
  await ctx.kv.set("joins", next, { ttlSeconds: ctx.config.raid.seconds });
  const c = ctx.config.raid,
    active = await ctx.kv.get<Raid>("raid");
  if (
    next.length >= c.joins ||
    (c.youngPercent > 0 &&
      next.length >= c.minimumSample &&
      next.filter((x) => x.young).length * 100 >= c.youngPercent * next.length)
  ) {
    await open(ctx, Math.round((next.length * 60) / c.seconds));
    const arrivals = (await ctx.kv.get<string[]>("arrivals")) ?? [];
    await ctx.kv.set(
      "arrivals",
      [...new Set([...arrivals, ...next.map((x) => x.id)])].slice(-1000),
      { ttlSeconds: 86400 },
    );
  } else if (active) {
    const arrivals = (await ctx.kv.get<string[]>("arrivals")) ?? [];
    await ctx.kv.set("arrivals", [...new Set([...arrivals, m.id])].slice(-1000), {
      ttlSeconds: 86400,
    });
  }
}
export async function quiet(ctx: Context) {
  const r = await readRaid(ctx);
  if (!r) return;
  if (
    r.until <= Date.now() ||
    r.phase === "closing" ||
    (r.enforced && ctx.config.mode !== "enforce")
  )
    await close(ctx);
  else if (!r.wake) await arm(ctx, r, r.until); // Upgrade a live legacy incident.
}
export async function control(ctx: Context, i: ComponentInteraction) {
  const [action, stamp] = i.componentId.split(":");
  const raid = await ctx.kv.get<Raid>("raid");
  const reply = (key: string) => i.reply({ ephemeral: true, content: tr(ctx, key) });
  if (!staff(i.member) || !raid || String(raid.started) !== stamp)
    return reply("message.unavailable");
  if (action === "lift") {
    return reply((await close(ctx)) ? "message.lifted" : "status.raidClosing");
  }
  if (action === "extend") {
    return reply(
      (await open(ctx, raid.rate)) === "active" ? "message.extended" : "status.raidPending",
    );
  }
  const arrivals = (await ctx.kv.get<string[]>("arrivals")) ?? [];
  if (action === "review") {
    const ids = arrivals.slice(-25);
    if (!ids.length) return reply("message.noRecentArrivals");
    await i.reply({
      ephemeral: true,
      content: tr(ctx, "message.reviewTheEvidenceSelectOnlyConfirmed"),
      components: [
        {
          type: "row",
          components: [
            {
              type: "select",
              id: "select:" + stamp,
              minValues: 1,
              maxValues: ids.length,
              options: ids.map((id) => ({ value: id, label: id })),
            },
          ],
        },
      ],
    });
    return;
  }
  const key = "selection:" + i.user.id;
  if (action === "select") {
    const ids = [...new Set(i.values)].filter((id) => arrivals.includes(id)).slice(0, 25);
    if (!ids.length) return reply("message.noMatchingArrivals");
    await ctx.kv.set(key, { stamp: raid.started, ids }, { ttlSeconds: 60 });
    await i.reply({
      ephemeral: true,
      content: tr(ctx, "message.confirmTheBanOfTheseAccounts") + ids.join(", "),
      components: [
        {
          type: "row",
          components: [
            {
              type: "button",
              id: "confirm:" + stamp,
              label: tr(ctx, "message.confirmBans"),
              style: "danger",
            },
          ],
        },
      ],
    });
    return;
  }
  const selected = await ctx.kv.get<{ stamp: number; ids: string[] }>(key);
  if (
    !raid.enforced ||
    (raid.phase && raid.phase !== "active") ||
    !selected ||
    selected.stamp !== raid.started
  )
    return reply("message.noActiveConfirmation");
  await ctx.kv.delete(key);
  for (const id of selected.ids) {
    if (!arrivals.includes(id)) continue;
    const member = await ctx.server.member(id);
    if (member && !exempt(ctx, member))
      await sanction(
        ctx,
        member,
        { type: "ban", minutes: 0 },
        "staff-confirmed raid account",
        "raid:" + stamp + ":" + id,
      );
  }
  return reply("message.reviewCompleted");
}
