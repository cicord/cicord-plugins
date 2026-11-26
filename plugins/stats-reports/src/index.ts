import {
  definePlugin,
  type Context,
  type AnalyticsSummary,
  type MessagePayload,
} from "@cicord/sdk";
const DAY = 86400000,
  MIN = 60000;
const day = (n: number) => new Date(n).toISOString().slice(0, 10);
const iso = (n: number) => new Date(n).toISOString();
function range(now: number, kind: "week" | "month") {
  const d = new Date(now);
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  if (kind === "week") {
    const to = midnight - ((d.getUTCDay() + 6) % 7) * DAY;
    return { from: to - 7 * DAY, to };
  }
  return {
    from: Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1),
    to: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1),
  };
}
export async function shortStays(ctx: Context, from: number, to: number) {
  let joined = 0,
    left = 0;
  for (let t = from; t < to; t += DAY) {
    joined += (await ctx.kv.get<number>("joins:" + day(t))) ?? 0;
    left += (await ctx.kv.get<number>("early:" + day(t))) ?? 0;
  }
  return { joined, left };
}
async function publish(ctx: Context, kind: "week" | "month") {
  if (!ctx.config.staffChannel) return;
  const { from, to } = range(Date.now(), kind),
    key = `report:${kind}:${day(to)}`,
    marker = `Activity · ${kind} · ${day(from)} to ${day(to)} UTC`;
  if (await ctx.kv.get(key)) return;
  const channel = ctx.server.channel(ctx.config.staffChannel);
  if (
    (await channel.messages({ limit: 50 })).some(
      (m) => m.author.id === ctx.bot.user.id && m.embeds.some((e) => e.title === marker),
    )
  ) {
    await ctx.kv.set(key, true);
    return;
  }
  const s = await ctx.analytics.summary({ from: iso(from), to: iso(to), granularity: "day" });
  const lines = s.kpis.map((k) => `${ctx.i18n.t(k.metric)}: ${Number(k.value.toFixed(2))}`);
  if (ctx.features.enabled("cohorts")) {
    const c = await shortStays(ctx, from, to);
    lines.push(ctx.i18n.t("cohort", c));
  } else lines.push(ctx.i18n.t("noCohort"));
  const top = s.channels.slice(0, 5);
  if (top.length) lines.push(ctx.i18n.t("channels"), ...top.map((c) => `${c.name}: ${c.value}`));
  let best = 0,
    when = "";
  s.heatmap.forEach((row, i) =>
    row.forEach((v, h) => {
      if (v > best) {
        best = v;
        when = `${["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][i]} ${String(h).padStart(2, "0")}:00 UTC`;
      }
    }),
  );
  if (best) lines.push(ctx.i18n.t("peak", { when, best }));
  const payload: MessagePayload = {
    embeds: [{ title: marker, description: lines.join("\n") }],
    allowedMentions: { roles: [], users: [], everyone: false },
  };
  if (ctx.features.enabled("charts")) {
    const points = s.series.find((q) => q.metric === "messages.sent")?.points ?? [];
    if (points.length) {
      const pic = await ctx.render.image({
        width: 640,
        height: 220,
        background: "#172032",
        layers: [
          { type: "text", x: 16, y: 12, text: ctx.i18n.t("daily"), size: 18, color: "#ffffff" },
          {
            type: "chart",
            x: 16,
            y: 52,
            width: 608,
            height: 148,
            color: "#74b8ff",
            kind: "bar",
            values: points.map((p) => p[1]),
          },
        ],
      });
      payload.files = [{ name: "activity.png", ...pic }];
      payload.embeds![0]!.image = { url: "attachment://activity.png" };
    }
  }
  await channel.send(payload);
  await ctx.kv.set(key, true);
}
export async function updateCounters(ctx: Context, s: AnalyticsSummary, now: number) {
  for (const metric of new Set(ctx.config.counters)) {
    const k = s.kpis.find((k) => k.metric === metric);
    if (!k) continue;
    const name = `${ctx.i18n.t(metric)}: ${Math.round(k.value)}`;
    const key = "counter:" + metric,
      rec = await ctx.kv.get<{ id: string; name: string; renamed: number[] }>(key);
    if (!rec) {
      const channel = await ctx.server.createChannel({ name, type: "voice" });
      await ctx.kv.set(key, { id: channel.id, name, renamed: [] });
      continue;
    }
    const recent = rec.renamed.filter((t) => t > now - 10 * MIN);
    if (rec.name === name || recent.length >= 2) continue;
    // Reserve the rename slot durably before Discord is called, including failed requests.
    await ctx.kv.set(key, { ...rec, renamed: [...recent, now] });
    await ctx.server.editChannel({ id: rec.id }, { name });
    await ctx.kv.set(key, { ...rec, name, renamed: [...recent, now] });
  }
}
export default definePlugin({
  events: {
    async memberJoin(ctx, m) {
      if (!ctx.features.enabled("cohorts")) return;
      const at = m.joinedAt?.getTime() ?? Date.now(),
        key = "arrival:" + (await ctx.privacy.pseudonym(m.id));
      const previous = await ctx.kv.getEntry<number>(key);
      if (previous?.value === at) return;
      await ctx.kv
        .atomic()
        .check(key, previous?.version)
        .set(key, at, { ttlSeconds: 30 * 86400 })
        .increment("joins:" + day(at))
        .commit();
    },
    async memberLeave(ctx, u) {
      if (!ctx.features.enabled("cohorts")) return;
      const key = "arrival:" + (await ctx.privacy.pseudonym(u.id)),
        entry = await ctx.kv.getEntry<number>(key);
      if (!entry) return;
      const batch = ctx.kv.atomic().check(key, entry.version).delete(key);
      if (Date.now() - entry.value < 7 * DAY) batch.increment("early:" + day(entry.value));
      await batch.commit();
    },
  },
  schedules: {
    reports: {
      cron: "5 * * * *",
      async run(ctx) {
        await publish(ctx, "week");
        await publish(ctx, "month");
      },
    },
    counters: {
      cron: "* * * * *",
      async run(ctx) {
        if (!ctx.features.enabled("counters") || !ctx.config.counters.length) return;
        const now = Date.now();
        const s = await ctx.analytics.summary({
          from: iso(now - DAY),
          to: iso(now),
          granularity: "day",
        });
        await updateCounters(ctx, s, now);
      },
    },
  },
  privacy: {
    async export(ctx, id) {
      return {
        joinedAt: (await ctx.kv.get("arrival:" + (await ctx.privacy.pseudonym(id)))) ?? null,
      };
    },
    async erase(ctx, id) {
      const key = "arrival:" + (await ctx.privacy.pseudonym(id)),
        exists = (await ctx.kv.get(key)) !== undefined;
      await ctx.kv.delete(key);
      return { erased: exists ? 1 : 0 };
    },
  },
});
