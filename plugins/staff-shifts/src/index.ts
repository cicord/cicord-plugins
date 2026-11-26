import {
  command,
  definePlugin,
  subcommand,
  type RouteResponse,
  type Context,
  type Json,
  type Member,
} from "@cicord/sdk";
import { ZONES } from "./tz.ts";
import { coverage, occurrences, validPlan, type Plan } from "./planning.ts";

type Duty = { start: number; end: number; task: string; role: string; owned: boolean };
type Roster = Plan & { task: string; next: number };
async function timerSubject(ctx: Context, id: string): Promise<string> {
  const key = "subjectFor:" + id;
  for (let i = 0; i < 8; i++) {
    const existing = await ctx.kv.get<string>(key);
    if (existing) return existing;
    const ref = String(await ctx.kv.increment("subjectSeq"));
    if (
      (
        await ctx.kv
          .atomic()
          .check(key, null)
          .set(key, ref)
          .set("subject:" + ref, id)
          .commit()
      ).ok
    )
      return ref;
  }
  throw Error("Concurrent staff schedule update");
}
const WEEK = 7 * 86400000;
const staff = (ctx: Context, m: Member | undefined) =>
  !!(m && ctx.config.staffRole && m.hasRole(ctx.config.staffRole));
async function off(ctx: Context, id: string, expected?: number) {
  const key = "duty:" + id,
    entry = await ctx.kv.getEntry(key);
  if (!entry) return;
  const d = entry.value as Duty;
  if (expected !== undefined && d.end !== expected) return;
  const m = await ctx.server.member(id);
  if (d.owned && m?.hasRole(d.role)) await m.removeRole(d.role, "End of staff duty");
  const duration = Math.max(0, Math.min(Date.now(), d.end) - d.start);
  const totalKey = "duration:" + id;
  for (let attempt = 0; attempt < 8; attempt++) {
    const total = await ctx.kv.getEntry<number>(totalKey);
    const tx = ctx.kv
      .atomic()
      .check(key, entry.version)
      .check(totalKey, total?.version ?? null)
      .delete(key)
      .set(totalKey, (total?.value ?? 0) + duration, { ttlSeconds: 365 * 86400 });
    if ((await tx.commit()).ok) {
      await ctx.schedule.cancel(d.task);
      return;
    }
    if (!(await ctx.kv.get(key))) return;
  }
  throw Error("Concurrent staff duty update");
}
async function on(ctx: Context, m: Member) {
  if (!ctx.config.dutyRole) return;
  const key = "duty:" + m.id,
    old = await ctx.kv.get<Duty>(key);
  if (old && old.end <= Date.now()) await off(ctx, m.id, old.end);
  let d = await ctx.kv.get<Duty>(key);
  if (!d) {
    const start = Date.now(),
      end = start + ctx.config.maxHours * 3600000;
    const task = await ctx.schedule.after(end - start, "expire", {
      ref: await timerSubject(ctx, m.id),
      end,
    });
    d = {
      start,
      end,
      task: task.id,
      role: ctx.config.dutyRole,
      owned: !m.hasRole(ctx.config.dutyRole),
    };
    if (!(await ctx.kv.atomic().check(key, null).set(key, d).commit()).ok) {
      await ctx.schedule.cancel(task.id);
      return;
    }
  }
  if (!m.hasRole(d.role)) await m.addRole(d.role, "Start of staff duty");
}
async function current(ctx: Context) {
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await ctx.kv.list<Duty>({ prefix: "duty:", limit: 100, cursor });
    for (const { key, value } of page.items)
      if (value.end > Date.now()) {
        const id = key.slice(5),
          m = await ctx.server.member(id);
        if (staff(ctx, m) && m?.hasRole(value.role)) ids.push(id);
      }
    cursor = page.cursor;
  } while (cursor);
  return ids;
}
async function schedule(ctx: Context, id: string, plan: Plan, after: number) {
  if (!plan.shifts.length || !ctx.config.reminderMinutes || !ctx.features.enabled("reminders"))
    return { ...plan, next: 0, task: "" };
  const lead = ctx.config.reminderMinutes * 60000;
  const next = occurrences(plan, after, after + 9 * 86400000)
    .map((w) => w.start - lead)
    .find((t) => t > after);
  if (!next) return { ...plan, next: 0, task: "" };
  const task = await ctx.schedule.after(Math.max(1, next - Date.now()), "remind", {
    ref: await timerSubject(ctx, id),
    next,
  });
  return { ...plan, next, task: task.id };
}
async function stat(ctx: Context, payload: Json, meta: { id: string }, kind: "ticket" | "case") {
  if (!ctx.config.enabled || !ctx.features.enabled("statistics")) return;
  const p = payload as Record<string, Json>;
  const id = kind === "ticket" ? p.assignee : (p.moderatorId ?? p.moderator);
  if (typeof id !== "string" || !staff(ctx, await ctx.server.member(id))) return;
  const receipt = `receipt:${id}:${meta.id}`;
  const key = kind + ":" + id;
  for (let attempt = 0; attempt < 8; attempt++) {
    if (await ctx.kv.get(receipt)) return;
    const current = await ctx.kv.getEntry<number>(key);
    const tx = ctx.kv
      .atomic()
      .check(receipt, null)
      .check(key, current?.version ?? null)
      .set(receipt, true, { ttlSeconds: 31 * 86400 })
      .set(key, (current?.value ?? 0) + 1, { ttlSeconds: 365 * 86400 });
    if ((await tx.commit()).ok) return;
  }
  throw Error("Concurrent staff statistics update");
}
async function data(ctx: Context, id: string, erase: boolean) {
  const data: Record<string, Json> = {};
  let erased = 0;
  for (const name of ["duty", "plan", "duration", "ticket", "case"]) {
    const key = name + ":" + id,
      value = await ctx.kv.get(key);
    if (value === undefined) continue;
    data[name] = value;
    erased++;
    if (erase) {
      if (name === "duty") await off(ctx, id);
      if (name === "plan" && (value as Roster).task)
        await ctx.schedule.cancel((value as Roster).task);
      await ctx.kv.delete(key);
    }
  }
  let cursor: string | undefined;
  const receipts: string[] = [];
  do {
    const page = await ctx.kv.list({ prefix: "receipt:" + id + ":", limit: 100, cursor });
    for (const item of page.items) {
      receipts.push(item.key);
      if (erase) await ctx.kv.delete(item.key);
    }
    cursor = page.cursor;
  } while (cursor);
  const ref = await ctx.kv.get<string>("subjectFor:" + id);
  if (ref && erase) {
    await ctx.kv
      .atomic()
      .delete("subjectFor:" + id)
      .delete("subject:" + ref)
      .commit();
    erased += 2;
  }
  return {
    data: { ...data, receipts, ...(ref ? { timerReference: ref } : {}) },
    erased: erased + receipts.length,
  };
}
export default definePlugin({
  async onStart(ctx) {
    await ctx.kv.set("meta:schema", 1);
  },
  commands: {
    duty: command({
      description: "Manage your on-duty status",
      ephemeral: true,
      subcommands: {
        on: subcommand({
          description: "Start duty",
          async run(ctx, i) {
            if (!ctx.config.enabled || !i.member || !staff(ctx, i.member))
              return i.reply(ctx.i18n.t("staff"));
            await on(ctx, i.member);
            await i.reply(ctx.i18n.t("on"));
          },
        }),
        off: subcommand({
          description: "End duty",
          async run(ctx, i) {
            await off(ctx, i.user.id);
            await i.reply(ctx.i18n.t("off"));
          },
        }),
      },
    }),
  },
  queries: {
    onDuty: {
      async run(ctx) {
        return { userIds: ctx.config.enabled ? await current(ctx) : [] };
      },
    },
  },
  events: {
    async memberUpdate(ctx, m) {
      if (!staff(ctx, m)) await off(ctx, m.id);
    },
    async memberLeave(ctx, m) {
      await data(ctx, m.id, true);
    },
  },
  subscriptions: {
    "tickets.closed": (ctx, p, meta) => stat(ctx, p, meta, "ticket"),
    "moderation.case": (ctx, p, meta) => stat(ctx, p, meta, "case"),
  },
  tasks: {
    async expire(ctx, p) {
      const { ref, end } = p as { ref: string; end: number },
        id = await ctx.kv.get<string>("subject:" + ref);
      if (id && end <= Date.now()) await off(ctx, id, end);
    },
    async remind(ctx, p) {
      const { ref, next } = p as { ref: string; next: number },
        id = await ctx.kv.get<string>("subject:" + ref);
      if (!id) return;
      const plan = await ctx.kv.get<Roster>("plan:" + id);
      if (!plan || plan.next !== next || !ctx.config.enabled) return;
      const m = await ctx.server.member(id);
      if (!staff(ctx, m)) return;
      if (
        ctx.features.enabled("reminders") &&
        Date.now() < next + ctx.config.reminderMinutes * 60000
      )
        await m!.send({
          content: ctx.i18n.t("remind", {
            when: `<t:${Math.floor(next / 1000) + ctx.config.reminderMinutes * 60}:R>`,
          }),
          nonce: `s${id.slice(-10)}${next.toString(36)}`,
          enforceNonce: true,
        });
      await ctx.kv.set("plan:" + id, await schedule(ctx, id, plan, Math.max(next, Date.now())));
    },
  },
  routes: {
    "GET /me": {
      access: "member",
      async handler(ctx, r): Promise<RouteResponse> {
        if (!staff(ctx, r.viewer?.member)) return { status: 403 };
        const id = r.viewer!.user.id,
          [plan, duty, duration, tickets, cases] = await ctx.kv.getMany([
            "plan:" + id,
            "duty:" + id,
            "duration:" + id,
            "ticket:" + id,
            "case:" + id,
          ]);
        const schedule = plan as Roster | undefined,
          d = duty as Duty | undefined;
        return {
          ...(schedule ? { plan: { zone: schedule.zone, shifts: schedule.shifts } } : {}),
          ...(d ? { duty: { start: d.start, end: d.end } } : {}),
          zones: Object.keys(ZONES),
          duration: duration ?? 0,
          ticket: tickets ?? 0,
          case: cases ?? 0,
        };
      },
    },
    "PUT /me/plan": {
      access: "member",
      async handler(ctx, r): Promise<RouteResponse> {
        if (!ctx.config.enabled || !staff(ctx, r.viewer?.member)) return { status: 403 };
        if (!validPlan(r.body)) return { status: 422 };
        const id = r.viewer!.user.id,
          old = await ctx.kv.get<Roster>("plan:" + id);
        const plan = await schedule(ctx, id, r.body, Date.now());
        await ctx.kv.set("plan:" + id, plan);
        if (old?.task) await ctx.schedule.cancel(old.task);
        return { saved: true };
      },
    },
    "GET /coverage": {
      access: "member",
      async handler(ctx, r): Promise<RouteResponse> {
        if (!staff(ctx, r.viewer?.member)) return { status: 403 };
        const from = r.query.from ? Date.parse(r.query.from) : Date.now();
        if (!Number.isFinite(from)) return { status: 422 };
        const plans: Plan[] = [];
        let cursor: string | undefined;
        do {
          const page = await ctx.kv.list<Roster>({ prefix: "plan:", limit: 100, cursor });
          for (const item of page.items) {
            if (staff(ctx, await ctx.server.member(item.key.slice(5)))) plans.push(item.value);
          }
          cursor = page.cursor;
        } while (cursor);
        return { from, to: from + WEEK, gaps: coverage(plans, from, from + WEEK) };
      },
    },
  },
  privacy: {
    async export(ctx, id): Promise<Json> {
      return (await data(ctx, id, false)).data;
    },
    async erase(ctx, id) {
      return { erased: (await data(ctx, id, true)).erased };
    },
  },
});
