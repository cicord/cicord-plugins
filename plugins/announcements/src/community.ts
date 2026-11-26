import {
  command,
  subcommand,
  type Context,
  type Json,
  type Message,
  type MessagePayload,
  type TextChannel,
} from "@cicord/sdk";
import { parseLocal, toUtc } from "./tz.ts";
import { adKey, renderScheduled, type Scheduled } from "./messages.ts";

const H = 3600000,
  DAY = 24 * H,
  MIN = 60000,
  none = { users: false, roles: false, everyone: false };
type Countdown = {
  id: string;
  title: string;
  end: number;
  channel: string;
  created: number;
  message?: string;
  milestones: number[];
  done: number[];
  next: number;
};
type Sticky = { count: number; last: number; message?: string; pending?: number };

export async function send(ctx: Context, channel: TextChannel, message: MessagePayload) {
  const posted = await channel.send(message);
  if (ctx.config.crosspost && channel.type === "announcement") {
    if (await ctx.kv.get("crosspost:" + channel.id)) return posted;
    if (typeof posted.crosspost !== "function") {
      ctx.features.report?.("crosspost", false, "SDK-14 message.crosspost unavailable");
      ctx.log.warn("Crosspost disabled: SDK-14 is unavailable");
    } else
      try {
        await posted.crosspost();
        ctx.features.report?.("crosspost", true);
      } catch (e) {
        ctx.features.report?.("crosspost", false, "Discord refused publication in " + channel.id);
        ctx.log.warn("Crosspost refused; announcement retained", {
          channel: channel.id,
          error: String(e),
        });
        await ctx.kv.set(
          "crosspost:" + channel.id,
          { at: Date.now(), message: posted.id },
          { ttlSeconds: 3600 },
        );
      }
  }
  return posted;
}
export async function countdown(ctx: Context, raw: Json | undefined) {
  if (ctx.config.enabled === false || !ctx.features.enabled("countdowns")) return;
  const { id, next } = raw as { id: string; next: number },
    k = "count:" + id,
    c = await ctx.kv.get<Countdown>(k);
  if (!c || c.next !== next) return;
  const channel = ctx.server.channel({ id: c.channel }),
    now = Date.now(),
    relative = `<t:${Math.floor(c.end / 1000)}:R>`;
  for (const before of c.milestones) {
    const at = c.end - before;
    if (c.done.includes(before) || at > now) continue;
    if (at >= c.created && now - at < H && now < c.end) {
      const when = before === 7 * DAY ? "week" : before === DAY ? "day" : "hour";
      const milestone =
        ctx.i18n.t(when, { title: c.title }) + (now - at >= MIN ? " " + ctx.i18n.t("late") : "");
      await send(ctx, channel, {
        content: milestone,
        allowedMentions: none,
        nonce: `m${id}-${before}`,
        enforceNonce: true,
      });
    }
    c.done.push(before);
    await ctx.kv.set(k, c);
  }
  if (now >= c.end) {
    await send(ctx, channel, {
      content: ctx.i18n.t("final", { title: c.title }),
      allowedMentions: none,
      nonce: "f" + id,
      enforceNonce: true,
    });
    await ctx.kv.delete(k);
    return;
  }
  const body = {
    content: ctx.i18n.t("countdown", { title: c.title, when: relative }),
    allowedMentions: none,
  };
  const existing = c.message ? await channel.message(c.message) : undefined;
  if (existing) await existing.edit(body);
  else c.message = (await send(ctx, channel, { ...body, nonce: "c" + id, enforceNonce: true })).id;
  const target = Math.min(
    c.end,
    now + (c.end - now <= H ? MIN : 5 * MIN),
    ...c.milestones.map((b) => c.end - b).filter((at) => at > now),
  );
  await ctx.schedule.after(Math.max(1, target - now), "countdown", { id, next: target });
  c.next = target;
  await ctx.kv.set(k, c);
}
function allowed(ctx: Context, c: TextChannel) {
  return (
    ["text", "announcement", "thread"].includes(c.type) &&
    (!ctx.config.channels.length ||
      ctx.config.channels.some((key) => ctx.server.channel(key).id === c.id))
  );
}
export const countdownCommand = command({
  description: "Manage countdown announcements",
  ephemeral: true,
  permissions: ["ManageMessages"],
  subcommands: {
    create: subcommand({
      description: "Create a countdown",
      options: {
        title: { type: "string", description: "Countdown title", required: true, maxLength: 160 },
        date: {
          type: "string",
          description: "End date in configured local time (YYYY-MM-DD HH:MM)",
          required: true,
        },
        channel: { type: "channel", description: "Destination", required: true },
        milestones: { type: "string", description: "Comma-separated milestones (7d,1d,1h)" },
      },
      async run(ctx, i) {
        const c = ctx.server.channel({ id: i.options.channel.id }),
          local = parseLocal(i.options.date),
          end = local === undefined ? 0 : toUtc(ctx.config.timeZone, local) * MIN;
        const values: Record<string, number> = { "7d": 7 * DAY, "1d": DAY, "1h": H };
        const labels = (i.options.milestones ?? "7d,1d,1h")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        if (
          !ctx.config.enabled ||
          !ctx.features.enabled("countdowns") ||
          !allowed(ctx, c) ||
          !i.member?.canView(c) ||
          end <= Date.now() ||
          end > Date.now() + 366 * DAY ||
          labels.some((s) => !Object.hasOwn(values, s))
        )
          return i.reply(ctx.i18n.t("invalidCountdown"));
        const id = String(await ctx.kv.increment("count-seq")),
          next = Date.now();
        const record: Countdown = {
          id,
          title: i.options.title,
          end,
          channel: c.id,
          created: next,
          milestones: [...new Set(labels.map((s) => values[s]!))],
          done: [],
          next,
        };
        await ctx.schedule.after(1000, "countdown", { id, next });
        await ctx.kv.set("count:" + id, record);
        await i.reply(ctx.i18n.t("countSaved"));
      },
    }),
  },
});
export async function countPosts(ctx: Context, m: Message) {
  if (!ctx.config.enabled || m.author.bot || !ctx.features.enabled("stickies")) return;
  const rule = ctx.config.stickies.find(
    (s) => s.channel === m.channel.key || s.channel === m.channel.id,
  );
  if (!rule) return;
  const k = "sticky:" + m.channel.id,
    receipt = "seen:" + m.id;
  for (let i = 0; i < 10; i++) {
    if (await ctx.kv.get(receipt)) return;
    const entry = await ctx.kv.getEntry(k),
      s: Sticky = (entry?.value as Sticky | undefined) ?? { count: 0, last: 0 };
    s.count++;
    let task: string | undefined;
    if (!s.pending && s.count >= rule.afterMessages) {
      s.pending = Math.max(Date.now() + 30000, s.last + 30000);
      task = (
        await ctx.schedule.after(Math.max(1, s.pending - Date.now()), "sticky", {
          channel: m.channel.id,
          pending: s.pending,
        })
      ).id;
    }
    if (
      (
        await ctx.kv
          .atomic()
          .check(k, entry?.version ?? null)
          .check(receipt, null)
          .set(receipt, true, { ttlSeconds: 300 })
          .set(k, s)
          .commit()
      ).ok
    )
      return;
    if (task) await ctx.schedule.cancel(task);
  }
  throw Error("Concurrent sticky counter updates");
}
export async function sticky(ctx: Context, raw: Json | undefined) {
  const { channel, pending } = raw as { channel: string; pending: number },
    c = ctx.server.channel({ id: channel }),
    k = "sticky:" + channel,
    s = await ctx.kv.get<Sticky>(k);
  if (typeof c.pins !== "function") {
    ctx.features.report?.("stickies", false, "SDK-14 channel.pins unavailable");
    return;
  }
  if (!s || s.pending !== pending || !ctx.config.enabled || !ctx.features.enabled("stickies"))
    return;
  const rule = ctx.config.stickies.find((r) => c.id === r.channel || c.key === r.channel);
  if (!rule) return;
  if (s.message) {
    const old = await c.message(s.message);
    if (old) await old.delete("Refresh sticky message");
  }
  const posted = await c.send({
    content: rule.message,
    allowedMentions: none,
    nonce: `s${channel.slice(-10)}${pending.toString(36)}`,
    enforceNonce: true,
  });
  if (typeof posted.pin === "function") await posted.pin();
  else ctx.log.warn("Sticky pin disabled: SDK-14 is unavailable");
  await ctx.kv.set(k, { count: 0, last: Date.now(), message: posted.id });
}
export async function portalCompose(
  ctx: Context,
  viewer: NonNullable<import("@cicord/sdk").RouteRequest["viewer"]> | undefined,
  body: Json | undefined,
  preview: boolean,
): Promise<import("@cicord/sdk").RouteResponse> {
  const p = body as
    | { channel?: string; title?: string; text?: string; at?: string; layout?: boolean }
    | undefined;
  if (
    !ctx.config.enabled ||
    !viewer?.member ||
    !p ||
    typeof p.channel !== "string" ||
    typeof p.text !== "string" ||
    !p.text.trim() ||
    p.text.length > 4000 ||
    (p.title !== undefined && (typeof p.title !== "string" || p.title.length > 256))
  )
    return { status: 422 };
  const c = ctx.server.channel({ id: p.channel });
  if (!allowed(ctx, c) || !viewer.member.canView(c)) return { status: 403 };
  const at = p.at ? Date.parse(p.at) : Date.now();
  if (!Number.isFinite(at) || at < Date.now() - MIN || at > Date.now() + 90 * DAY)
    return { status: 422 };
  const s: Scheduled = {
    id: 0,
    body: p.text,
    title: p.title,
    at,
    channelId: c.id,
    by: { id: viewer.user.id, name: viewer.user.displayName },
    createdAt: new Date().toISOString(),
    mentions: { roles: [] },
    layout: !!p.layout,
  };
  const message = renderScheduled(ctx, s);
  if (preview) return { message: message as unknown as Json };
  if (
    at > Date.now() + MIN &&
    (await ctx.kv.list({ prefix: "ad:", limit: ctx.config.maxScheduled })).items.length >=
      ctx.config.maxScheduled
  )
    return { status: 409 };
  s.id = await ctx.kv.increment("seq");
  s.taskId = (await ctx.schedule.after(Math.max(1, at - Date.now()), "post", { id: s.id })).id;
  await ctx.kv.set(adKey(s.id), s as unknown as Json);
  return { id: s.id };
}
