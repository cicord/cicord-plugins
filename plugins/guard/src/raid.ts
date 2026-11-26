import type { Context, Member, ComponentInteraction, OverwritePatch } from "@cicord/sdk";
import { MONTH, staff, tr } from "./data.ts";
import { exempt, recently } from "./rules.ts";
import { sanction } from "./sanctions.ts";

type Join = { id: string; at: number; young: boolean };
type Raid = { started: number; until: number; rate: number; enforced: boolean };
export const joins = async (ctx: Context) =>
  ((await ctx.kv.get<Join[]>("joins")) ?? []).filter(
    (x) => x.at >= Date.now() - ctx.config.raid.seconds * 1000,
  );

async function measures(ctx: Context, until: number) {
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
  if (ctx.features.enabled("pauseInvites")) {
    const duration =
      parseInt(config.pauseInvites, 10) * (config.pauseInvites.endsWith("h") ? 3600000 : 60000);
    await ctx.server.incident({
      invitesDisabledUntil: new Date(Math.min(until, Date.now() + duration)),
    });
  }
}
export async function open(ctx: Context, rate: number) {
  const previous = await ctx.kv.get<Raid>("raid"),
    now = Date.now();
  const next: Raid = {
    started: previous?.started ?? now,
    until: now + ctx.config.raid.calmMinutes * 60000,
    rate,
    enforced: ctx.config.mode === "enforce",
  };
  if (next.enforced) await measures(ctx, next.until);
  await ctx.kv.set("raid", next, { ttlSeconds: 7 * 86400 });
  if (previous) return;
  const names = next.enforced
    ? [
        "verificationLevel",
        ...(ctx.config.raid.measures.slowmode.channels.length ? ["slowmode"] : []),
        ...(ctx.config.raid.measures.lockChannels.length ? ["lock"] : []),
        ...(ctx.features.enabled("pauseInvites") ? ["pauseInvites"] : []),
      ]
    : [];
  await ctx.events.publish(
    "raid",
    { state: "started", joinsPerMinute: rate, measures: names },
    { idempotencyKey: "start:" + next.started },
  );
  if (ctx.config.staffChannel)
    await ctx.server.channel(ctx.config.staffChannel).send({
      content: tr(ctx, "message.joinSurgeDetected") + " (" + ctx.config.mode + ")",
      components: [
        {
          type: "row",
          components: [
            { type: "button", id: "lift:" + now, label: tr(ctx, "message.lift") },
            { type: "button", id: "extend:" + now, label: tr(ctx, "message.extend") },
            {
              type: "button",
              id: "review:" + now,
              label: tr(ctx, "message.reviewArrivals"),
            },
          ],
        },
      ],
    });
}
export async function close(ctx: Context) {
  const raid = await ctx.kv.get<Raid>("raid");
  if (!raid) return;
  if (raid.enforced) await ctx.server.overlays.remove("raid");
  // The incident deadline is bounded by the overlay's end; another incident owner
  // may require a longer pause. Do not clear guild-wide incident settings here.
  await ctx.kv.delete("raid");
  await ctx.kv.delete("arrivals");
  await ctx.kv.set(
    "raidHistory:" + raid.started,
    { started: raid.started, ended: Date.now(), rate: raid.rate, enforced: raid.enforced },
    { ttlSeconds: MONTH },
  );
  await ctx.events.publish(
    "raid",
    { state: "ended", joinsPerMinute: raid.rate, measures: [] },
    { idempotencyKey: "end:" + raid.started },
  );
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
  const r = await ctx.kv.get<Raid>("raid");
  if (r && r.until <= Date.now()) await close(ctx);
}
export async function control(ctx: Context, i: ComponentInteraction) {
  const [action, stamp] = i.componentId.split(":");
  const raid = await ctx.kv.get<Raid>("raid");
  const reply = (key: string) => i.reply({ ephemeral: true, content: tr(ctx, key) });
  if (!staff(i.member) || !raid || String(raid.started) !== stamp)
    return reply("message.unavailable");
  if (action === "lift") {
    await close(ctx);
    return reply("message.lifted");
  }
  if (action === "extend") {
    await open(ctx, raid.rate);
    return reply("message.extended");
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
  if (!raid.enforced || !selected || selected.stamp !== raid.started)
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
