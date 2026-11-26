import type {
  Context,
  Member,
  ComponentInteraction,
  Overlay,
  Permission,
} from "@cicord/sdk";
import { MONTH, rows, staff, tr } from "./data.ts";
import { exempt, recently } from "./rules.ts";
import { sanction } from "./sanctions.ts";

type Join = { id: string; at: number; young: boolean };
type Arrival = { at: number };
type Measure = "overlay" | "invites";
type Raid = {
  started: number;
  until: number;
  rate: number;
  enforced: boolean;
  /** Started or escalated by staff with /lockdown on: enforced whatever the mode. */
  manual?: boolean;
  /** Deadline last sent to the overlay and to Discord's invite pause. */
  overlayUntil?: number;
  invitesApplied?: number;
  phase?: "pending" | "active" | "closing";
  pending?: Measure[];
  invitesUntil?: number;
  wake?: string;
  alertNonce?: string;
  announced?: boolean;
  alerted?: boolean;
};
const RETRY_MS = 5000;
// A surge extends the raid on every qualifying join. Measures are re-sent only when
// their deadline would otherwise lapse within this margin.
const MARGIN_MS = 60000;
const RESUME_MS = 5000;
const readRaid = (ctx: Context) => ctx.kv.get<Raid>("raid");
const saveRaid = (ctx: Context, r: Raid) => ctx.kv.set("raid", r);
// Per-member keys: recording a join needs neither the raid lock nor a shared list.
export const JOIN = "join:",
  ARRIVAL = "arrival:";
export const joins = async (ctx: Context) =>
  (await rows<Join>(ctx, JOIN, 1000))
    .map((x) => x.value)
    .filter((x) => x.at >= Date.now() - ctx.config.raid.seconds * 1000);
export async function arrivals(ctx: Context) {
  return (await rows<Arrival>(ctx, ARRIVAL, 1000))
    .sort((a, b) => a.value.at - b.value.at)
    .map((x) => x.key.slice(ARRIVAL.length));
}
async function addArrivals(ctx: Context, ids: string[]) {
  for (const id of ids)
    if ((await ctx.kv.get(ARRIVAL + id)) === undefined)
      await ctx.kv.set(ARRIVAL + id, { at: Date.now() }, { ttlSeconds: 86400 });
}
/** The automatic close rule: mode switched back to monitor. Manual lockdowns stay. */
const demoted = (ctx: Context, r: Raid) =>
  r.enforced && !r.manual && ctx.config.mode !== "enforce";

async function applyOverlay(ctx: Context, until: number) {
  // Called with the raid deadline plus a margin, so a continuing surge re-sends it at
  // most about once a minute. Closing the raid removes it explicitly.
  if (!ctx.features.enabled("raidOverlay")) throw new Error("raidOverlay grant required");
  const config = ctx.config.raid.measures;
  const channels: NonNullable<Overlay["channels"]> = {};
  for (const c of config.slowmode.channels)
    channels[c] = { slowmodeSeconds: config.slowmode.seconds };
  // A role or member allow wins over the @everyone deny: "*" neutralizes every such allow
  // in the channel, except the bot's and the staff roles'.
  const locked: Permission[] = ["SendMessages", "SendMessagesInThreads"];
  for (const c of config.lockChannels)
    channels[c] = {
      ...channels[c],
      overwrites: { "@everyone": { deny: locked }, "*": { neutral: locked } },
    };
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
      content:
        tr(ctx, "message.joinSurgeDetected") + " (" + (r.manual ? "manual" : ctx.config.mode) + ")",
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
      if (measure === "overlay") {
        const until = r.until + 2 * MARGIN_MS;
        await applyOverlay(ctx, until);
        r.overlayUntil = until;
      } else if (r.invitesUntil && r.invitesUntil > Date.now()) {
        if (!ctx.features.enabled("pauseInvites")) throw new Error("pauseInvites grant required");
        await ctx.server.incident({ invitesDisabledUntil: new Date(r.invitesUntil) });
        r.invitesApplied = r.invitesUntil;
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

/** Measures whose last sent deadline no longer covers the raid. */
function stale(r: Raid): Measure[] {
  if (!r.enforced) return [];
  return [
    ...(!r.overlayUntil || r.until + MARGIN_MS > r.overlayUntil ? ["overlay" as const] : []),
    ...(r.invitesUntil &&
    r.invitesUntil > Date.now() &&
    (!r.invitesApplied || r.invitesUntil > r.invitesApplied + MARGIN_MS)
      ? ["invites" as const]
      : []),
  ];
}

export type OpenResult = "pending" | "active" | "closing" | "refused";
export async function open(ctx: Context, rate: number, manual = false): Promise<OpenResult> {
  const previous = await readRaid(ctx),
    now = Date.now();
  if (previous?.phase === "closing") return "closing";
  // A staff lockdown is a human decision: it applies even in monitor mode, and never
  // reports success when nothing could be applied.
  if (manual && !ctx.features.enabled("raidOverlay")) return "refused";
  const isManual = manual || previous?.manual === true;
  const until = Math.max(previous?.until ?? 0, now + ctx.config.raid.calmMinutes * 60000),
    // Once enforced, a raid stays enforced until closed, so its overlay is always removed.
    enforced = isManual || ctx.config.mode === "enforce" || previous?.enforced === true;
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
    rate: rate || previous?.rate || 0,
    enforced,
    ...(isManual ? { manual: true } : {}),
    phase: previous?.phase ?? "pending",
    invitesUntil: pause
      ? Math.max(previous?.invitesUntil ?? 0, Math.min(until, now + pauseMs))
      : previous?.invitesUntil,
    // Previously published versions did not persist announcement receipts.
    announced: previous?.announced ?? !!previous,
    alerted: previous?.alerted ?? !!previous,
  };
  if (previous && !previous.enforced && enforced) {
    // Escalated from a monitored raid: send every measure once.
    delete r.overlayUntil;
    delete r.invitesApplied;
  }
  r.pending = [...new Set([...(previous?.pending ?? []), ...stale(r)])];
  if (previous && previous.phase === "active" && !r.pending.length && r.alerted && r.announced) {
    // Nothing to send: only the deadline and the rate moved.
    await saveRaid(ctx, r);
    return "active";
  }
  r.phase = "pending";
  await arm(ctx, r, Math.min(until, now + RETRY_MS));
  await settle(ctx, r);
  return r.phase;
}

async function finishClose(ctx: Context, r: Raid) {
  try {
    if (r.enforced || r.overlayUntil) await ctx.server.overlays.remove("raid");
    // Discord accepts only a future end, so shorten our pause to a few seconds.
    const paused = r.invitesApplied ?? (r.pending?.includes("invites") ? 0 : r.invitesUntil) ?? 0;
    if (paused > Date.now() + RESUME_MS && ctx.features.enabled("pauseInvites")) {
      await ctx.server.incident({ invitesDisabledUntil: new Date(Date.now() + RESUME_MS) });
      r.invitesApplied = Date.now() + RESUME_MS;
      await saveRaid(ctx, r);
    }
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
    .commit();
  for (const row of await rows(ctx, ARRIVAL, 1000)) await ctx.kv.delete(row.key);
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
    demoted(ctx, r)
  ) {
    r.phase = "closing";
    await arm(ctx, r, Date.now() + RETRY_MS, wake);
    await finishClose(ctx, r);
    return;
  }
  // Reserve the next attempt before doing any Discord IO. A crashed handler,
  // a paused runtime and a failed incident each retain the desired deadline.
  r.pending = [...new Set([...(r.pending ?? []), ...stale(r)])];
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
        manual: r.manual === true,
        phase: r.phase ?? "active",
        pending: r.pending ?? [],
      }
    : null;
}
/** Runs without the raid lock: each join is its own key, and only a surge takes the lock. */
export async function onJoin(ctx: Context, m: Member, openRaid: (rate: number) => Promise<unknown>) {
  if (exempt(ctx, m)) return;
  const c = ctx.config.raid,
    now = Date.now();
  if ((await ctx.kv.get(JOIN + m.id)) !== undefined) return;
  const young = recently(m.user.createdAt, ctx.config.newAccounts.minAccountAgeDays * 86400000);
  await ctx.kv.set(JOIN + m.id, { id: m.id, at: now, young }, { ttlSeconds: c.seconds });
  const window = await joins(ctx);
  const surge =
    window.length >= c.joins ||
    (c.youngPercent > 0 &&
      window.length >= c.minimumSample &&
      window.filter((x) => x.young).length * 100 >= c.youngPercent * window.length);
  const active = await readRaid(ctx);
  if (!surge) {
    if (active) await addArrivals(ctx, [m.id]);
    return;
  }
  // A recently extended active raid needs no lock: its deadline moved within seconds.
  const fresh =
    active?.phase === "active" && active.until >= now + c.calmMinutes * 60000 - RETRY_MS;
  if (!fresh) await openRaid(Math.round((window.length * 60) / c.seconds));
  await addArrivals(ctx, active ? [m.id] : window.map((x) => x.id));
}
export async function quiet(ctx: Context) {
  const r = await readRaid(ctx);
  if (!r) return;
  if (
    r.until <= Date.now() ||
    r.phase === "closing" ||
    demoted(ctx, r)
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
  const recent = await arrivals(ctx);
  if (action === "review") {
    const ids = recent.slice(-25);
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
    const ids = [...new Set(i.values)].filter((id) => recent.includes(id)).slice(0, 25);
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
    if (!recent.includes(id)) continue;
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
