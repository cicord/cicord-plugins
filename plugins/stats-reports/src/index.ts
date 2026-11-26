import {
  definePlugin,
  command,
  type Context,
  type AnalyticsSummary,
  type MessagePayload,
} from "@cicord/sdk";
const DAY = 86400000,
  MIN = 60000;
const REPORT_TTL = 400 * 86400,
  LEASE = 12000;
type ReportReceipt = {
  state: "running" | "done" | "uncertain";
  first: number;
  lease: number;
  channel: string;
  message?: string;
};
type Counter = {
  id?: string;
  state?: "creating" | "uncertain";
  name: string;
  renamed: number[];
  lease?: number;
};
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
export async function publish(ctx: Context, kind: "week" | "month", periodAt = Date.now()) {
  if (!ctx.config.staffChannel) return;
  const { from, to } = range(periodAt, kind),
    key = `report:${kind}:${day(to)}`,
    marker = ctx.i18n.t(kind === "week" ? "weeklyHeading" : "monthlyHeading", {
      from: day(from),
      to: day(to),
    });
  const previous = await ctx.kv.getEntry<ReportReceipt | boolean>(key);
  if (previous?.value === true) return;
  const rec = typeof previous?.value === "object" ? previous.value : undefined;
  if (rec && rec.state !== "running") return;
  const channel = ctx.server.channel(ctx.config.staffChannel);
  const audience = ctx.server.audience(channel);
  if (!audience.known || audience.public) {
    ctx.log.warn("Report destination must be a known, private staff channel.");
    return;
  }
  const now = Date.now(),
    first = rec?.first ?? now;
  if (rec && now < rec.lease) return;
  if (rec && (now - first >= MIN || rec.channel !== channel.id)) {
    // Bounded recovery. An absent marker cannot establish that Discord never accepted a send.
    const proof =
      rec.channel === channel.id
        ? (await channel.messages({ limit: 50 })).find(
            (m) =>
              m.author.id === ctx.bot.user.id &&
              m.embeds.some((e) => e.footer?.text === key + "/" + ctx.plugin.instance),
          )
        : undefined;
    const updated = await ctx.kv
      .atomic()
      .check(key, previous?.version)
      .set(
        key,
        { ...rec, state: proof ? "done" : "uncertain", ...(proof ? { message: proof.id } : {}) },
        { ttlSeconds: REPORT_TTL },
      )
      .commit();
    if (!proof && updated.ok)
      ctx.log.warn("Report delivery unconfirmed. Automatic retries have stopped.", { period: key });
    return;
  }
  const s = await ctx.analytics.summary({ from: iso(from), to: iso(to), granularity: "day" });
  const lines = s.kpis.map((k) => `${ctx.i18n.t(k.metric)}: ${k.value}`);
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
        when = `${ctx.i18n.t("weekday" + i)} ${String(h).padStart(2, "0")}:00 UTC`;
      }
    }),
  );
  if (best) lines.push(ctx.i18n.t("peak", { when, best }));
  const payload: MessagePayload = {
    nonce: kind[0] + day(to),
    enforceNonce: true,
    embeds: [
      {
        title: marker,
        description: lines.join("\n"),
        footer: { text: key + "/" + ctx.plugin.instance },
      },
    ],
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
  const latest = ctx.server.audience(channel);
  if (!latest.known || latest.public) return;
  const claim = await ctx.kv
    .atomic()
    .check(key, previous?.version)
    .set(
      key,
      { state: "running", first, lease: Date.now() + LEASE, channel: channel.id },
      { ttlSeconds: REPORT_TTL },
    )
    .commit();
  if (!claim.ok) return;
  const message = await channel.send(payload);
  await ctx.kv.set(
    key,
    { state: "done", first, lease: 0, channel: channel.id, message: message.id },
    { ttlSeconds: REPORT_TTL },
  );
}
export async function updateCounters(ctx: Context, s: AnalyticsSummary, now: number) {
  for (const metric of new Set(ctx.config.counters)) {
    const k = s.kpis.find((k) => k.metric === metric);
    if (!k) continue;
    const name = `${ctx.i18n.t(metric)}: ${Math.round(k.value)}`;
    const key = "counter:" + metric,
      entry = await ctx.kv.getEntry<Counter>(key),
      rec = entry?.value;
    if (!rec) {
      const claimed = await ctx.kv
        .atomic()
        .check(key, undefined)
        .set(key, { name, state: "creating", lease: now + LEASE, renamed: [] })
        .commit();
      if (!claimed.ok) continue;
      const ch = await ctx.server.createChannel({ name, type: "voice" });
      await ctx.kv.set(key, { id: ch.id, name, renamed: [] });
      continue;
    }
    if (!rec.id) {
      if (rec.state === "creating" && now >= (rec.lease ?? 0)) {
        const changed = await ctx.kv
          .atomic()
          .check(key, entry?.version)
          .set(key, { ...rec, state: "uncertain" })
          .commit();
        if (changed.ok)
          ctx.log.warn(
            "Counter creation outcome unknown. Inspect Discord and resolve with /stats-counter.",
            { metric },
          );
      }
      continue;
    }
    const recent = rec.renamed.filter((t) => t > now - 10 * MIN);
    if (rec.name === name || recent.length >= 2 || now < (rec.lease ?? 0)) continue;
    const renamed = [...recent, now],
      claimed = await ctx.kv
        .atomic()
        .check(key, entry?.version)
        .set(key, { ...rec, renamed, lease: now + LEASE })
        .commit();
    if (!claimed.ok) continue;
    await ctx.server.editChannel({ id: rec.id }, { name });
    await ctx.kv.set(key, { id: rec.id, name, renamed });
  }
}
export default definePlugin({
  commands: {
    "stats-counter": command({
      description: "Resolve an uncertain counter creation after inspecting Discord",
      permissions: ["Administrator"],
      ephemeral: true,
      options: {
        metric: {
          type: "string",
          required: true,
          description: "Counter metric",
          choices: [
            { name: "Members", value: "members.total" },
            { name: "Online", value: "members.online" },
            { name: "Boosts", value: "members.boosting" },
          ],
        },
        checked: {
          type: "boolean",
          required: true,
          description: "I verified whether Discord created the channel",
        },
        channel: {
          type: "channel",
          description: "Existing owned voice counter; omit only when no channel was created",
        },
      },
      async run(ctx, it) {
        if (it.member?.access !== "admin" || !it.options.checked) {
          await it.reply(ctx.i18n.t("adminConfirm"));
          return;
        }
        const key = "counter:" + it.options.metric,
          entry = await ctx.kv.getEntry<Counter>(key);
        if (entry?.value.state !== "uncertain") {
          await it.reply(ctx.i18n.t("noUncertain"));
          return;
        }
        const channel = it.options.channel;
        if (channel) {
          if (channel.type !== "voice") {
            await it.reply(ctx.i18n.t("needVoice"));
            return;
          }
          // Host refuses edits to channels owned by Git, Discord users or another instance.
          await ctx.server.editChannel(channel, { name: entry.value.name });
        }
        const change = ctx.kv.atomic().check(key, entry.version);
        if (channel)
          change.set(key, { id: channel.id, name: entry.value.name, renamed: [Date.now()] });
        else change.delete(key);
        await it.reply(ctx.i18n.t((await change.commit()).ok ? "resolved" : "noUncertain"));
      },
    }),
  },
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
