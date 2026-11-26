import {
  command,
  definePlugin,
  subcommand,
  type RouteResponse,
  type Context,
  type Json,
} from "@cicord/sdk";
import { anniversary, validDate, yearAt } from "./dates.ts";
import { ZONES, toLocal } from "./tz.ts";

type Birthday = {
  id: string;
  owner: string;
  month: number;
  day: number;
  since: number;
  year: number;
  task: string;
  wake: number;
  announced?: number;
  roleDone?: number;
};
type Grant = { role: string; until: number; task: string };
const DAY = 86400000;
async function memberZone(ctx: Context, id: string) {
  if (ctx.features.enabled("personalTimeZone") && ctx.plugins.has("reminders")) {
    const res = (await ctx.plugins.query("reminders", "timezone", { userId: id })) as {
      timeZone?: string;
    };
    if (res.timeZone && Object.hasOwn(ZONES, res.timeZone)) return res.timeZone;
  }
  return ctx.config.timeZone;
}
const get = (ctx: Context, id: string) => ctx.kv.get<Birthday>("birthday:" + id);
const byOwner = async (ctx: Context, owner: string) => {
  const id = await ctx.kv.get<string>("owner:" + owner);
  return id ? get(ctx, id) : undefined;
};

async function save(ctx: Context, owner: string, month: number, day: number) {
  const old = await byOwner(ctx, owner);
  if (old?.month === month && old.day === day) return;
  const id = old?.id ?? String(await ctx.kv.increment("seq")),
    wake = Date.now() + 1200;
  const task = (await ctx.schedule.after(1200, "celebrate", { id, wake })).id;
  const b: Birthday = {
    id,
    owner,
    month,
    day,
    since: Date.now(),
    year: old?.year ?? 0,
    task,
    wake,
  };
  const zone = await memberZone(ctx, owner),
    year = yearAt(Date.now(), zone);
  let next = anniversary(year, month, day, ctx.config.hour, zone);
  if (next < Date.now()) next = anniversary(year + 1, month, day, ctx.config.hour, zone);
  await ctx.kv
    .atomic()
    .set("owner:" + owner, id)
    .set("birthday:" + id, b)
    .rankSet("upcoming", id, -next)
    .commit();
  if (old) await ctx.schedule.cancel(old.task);
}

async function clearRole(ctx: Context, b: Birthday, force = false) {
  const grant = await ctx.kv.get<Grant>("grant:" + b.id);
  if (!grant || (!force && grant.until > Date.now())) return;
  const member = await ctx.server.member(b.owner);
  if (member?.hasRole(grant.role)) await member.removeRole(grant.role, "Birthday role expired");
  await ctx.kv.delete("grant:" + b.id);
  await ctx.schedule.cancel(grant.task);
}
async function erase(ctx: Context, owner: string) {
  const b = await byOwner(ctx, owner);
  if (!b) return { erased: 0 };
  await clearRole(ctx, b, true);
  await ctx.schedule.cancel(b.task);
  await ctx.kv
    .atomic()
    .delete("owner:" + owner)
    .delete("birthday:" + b.id)
    .rankRemove("upcoming", b.id)
    .commit();
  return { erased: 1 };
}

async function role(ctx: Context, b: Birthday, year: number) {
  const role = ctx.config.role;
  if (!role) return;
  if (ctx.plugins.has("member-roles")) {
    if (!ctx.features.enabled("temporaryRole")) {
      ctx.log.warn("Birthday role disabled: grant plugins.call:member-roles.grantTemporary");
      return;
    }
    await ctx.plugins.call(
      "member-roles",
      "grantTemporary",
      { userId: b.owner, role, durationSeconds: 86400, reason: "Birthday" },
      { idempotencyKey: `birthday:${b.id}:${year}` },
    );
    return;
  }
  if (!ctx.features.enabled("directRole")) {
    ctx.log.warn("Birthday role disabled: grant discord.roles.assign or install member-roles");
    return;
  }
  const member = await ctx.server.member(b.owner);
  if (!member) return;
  let grant = await ctx.kv.get<Grant>("grant:" + b.id);
  if (!grant) {
    if (member.hasRole(role)) return;
    const until = Date.now() + DAY;
    const task = await ctx.schedule.after(DAY, "expire", { id: b.id, until });
    grant = { role, until, task: task.id };
    await ctx.kv.set("grant:" + b.id, grant);
  }
  if (!member.hasRole(role)) await member.addRole(role, "Birthday");
}

async function celebrate(ctx: Context, payload: Json | undefined) {
  if (!ctx.config.enabled || !ctx.config.channel) return;
  const p = payload as { id: string; wake: number },
    b = await get(ctx, p.id);
  if (!b || b.wake !== p.wake) return;
  const zone = await memberZone(ctx, b.owner),
    now = Date.now(),
    localYear = yearAt(now, zone);
  const thisYear = anniversary(localYear, b.month, b.day, ctx.config.hour, zone);
  const year = thisYear > now ? localYear - 1 : localYear;
  const at = anniversary(year, b.month, b.day, ctx.config.hour, zone);
  const sameDay =
    Math.floor(toLocal(zone, Math.floor(now / 60000)) / 1440) ===
    Math.floor(toLocal(zone, at / 60000) / 1440);
  const due = at <= now && (at >= b.since || sameDay) && b.year !== year;
  if (due && (await ctx.server.member(b.owner))) {
    if (b.announced !== year) {
      await ctx.server
        .channel(ctx.config.channel)
        .send({
          content: ctx.i18n.t("greeting", { member: `<@${b.owner}>` }),
          allowedMentions: { users: [b.owner], roles: false, everyone: false },
          nonce: `bd${b.id}-${year}`,
          enforceNonce: true,
        });
      b.announced = year;
      await ctx.kv.set("birthday:" + b.id, b);
    }
    if (b.roleDone !== year) {
      await role(ctx, b, year);
      b.roleDone = year;
      await ctx.kv.set("birthday:" + b.id, b);
    }
    await ctx.events.publish(
      "today",
      { userId: b.owner },
      { version: 1, idempotencyKey: `birthday:${b.id}:${year}` },
    );
    b.year = year;
  }
  const next = anniversary(year + 1, b.month, b.day, ctx.config.hour, zone);
  // Reevaluate changes to the member's timezone at least daily.
  const wake = Math.min(now + DAY, next),
    task = await ctx.schedule.after(Math.max(1000, wake - now), "celebrate", { id: b.id, wake });
  const e = await ctx.kv.getEntry("birthday:" + b.id);
  if (
    !e ||
    (e.value as Birthday).wake !== p.wake ||
    !(
      await ctx.kv
        .atomic()
        .check("birthday:" + b.id, e.version)
        .set("birthday:" + b.id, { ...b, since: now, wake, task: task.id })
        .rankSet("upcoming", b.id, -next)
        .commit()
    ).ok
  )
    await ctx.schedule.cancel(task.id);
}
async function upcoming(ctx: Context) {
  const out: { owner: string; at: number }[] = [];
  for (const entry of await ctx.kv.ranking("upcoming").top({ limit: 10 })) {
    const b = await get(ctx, entry.member);
    if (b) out.push({ owner: b.owner, at: -entry.score });
  }
  return out;
}

export default definePlugin({
  async onStart(ctx) {
    await ctx.kv.set("meta:schema", 1);
  },
  events: {
    async memberLeave(ctx, m) {
      if (ctx.config.eraseOnLeave) await erase(ctx, m.id);
    },
  },
  tasks: {
    celebrate,
    async expire(ctx, payload) {
      const p = payload as { id: string; until: number },
        b = await get(ctx, p.id);
      if (b && (await ctx.kv.get<Grant>("grant:" + b.id))?.until === p.until)
        await clearRole(ctx, b);
    },
  },
  commands: {
    birthday: command({
      description: "Opt in to birthday celebrations",
      ephemeral: true,
      subcommands: {
        set: subcommand({
          description: "Save your day and month",
          options: {
            day: { type: "integer", description: "Day", min: 1, max: 31, required: true },
            month: { type: "integer", description: "Month", min: 1, max: 12, required: true },
          },
          async run(ctx, i) {
            if (!ctx.config.enabled || !validDate(i.options.month, i.options.day))
              return i.reply(ctx.i18n.t("invalid"));
            await save(ctx, i.user.id, i.options.month, i.options.day);
            await i.reply(ctx.i18n.t("saved"));
          },
        }),
        remove: subcommand({
          description: "Withdraw your birthday",
          async run(ctx, i) {
            await erase(ctx, i.user.id);
            await i.reply(ctx.i18n.t("removed"));
          },
        }),
        upcoming: subcommand({
          description: "Show the next ten birthdays",
          async run(ctx, i) {
            const rows = await upcoming(ctx);
            await i.reply({
              content:
                rows.map((r) => `<t:${Math.floor(r.at / 1000)}:D> · <@${r.owner}>`).join("\n") ||
                ctx.i18n.t("empty"),
              allowedMentions: { users: false, roles: false, everyone: false },
              ephemeral: true,
            });
          },
        }),
      },
    }),
  },
  routes: {
    "GET /birthday": {
      access: "member",
      async handler(ctx, req): Promise<RouteResponse> {
        const b = req.viewer && (await byOwner(ctx, req.viewer.user.id));
        return { birthday: b ? { month: b.month, day: b.day } : null };
      },
    },
    "PUT /birthday": {
      access: "member",
      async handler(ctx, req): Promise<RouteResponse> {
        const data = req.body as { day: number; month: number } | undefined;
        if (!ctx.config.enabled || !req.viewer || !data || !validDate(data.month, data.day))
          return { status: 400, body: { error: "invalid_date" } };
        await save(ctx, req.viewer.user.id, data.month, data.day);
        return { saved: true };
      },
    },
    "DELETE /birthday": {
      access: "member",
      async handler(ctx, req): Promise<RouteResponse> {
        return req.viewer ? erase(ctx, req.viewer.user.id) : { status: 403 };
      },
    },
  },
  privacy: {
    async export(ctx, id): Promise<Json> {
      const b = await byOwner(ctx, id);
      if (!b) return {};
      const role = await ctx.kv.get("grant:" + b.id);
      return {
        birthday: { day: b.day, month: b.month },
        lastCelebrationYear: b.year || null,
        role: role ?? null,
      };
    },
    erase,
  },
});
