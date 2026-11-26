import {
  command,
  definePlugin,
  subcommand,
  type Channel,
  type Context,
  type Json,
  type Interaction,
  type Member,
} from "@cicord/sdk";
import { duration, localMs, nextDue, parseDate } from "./time.ts";
import { ZONES } from "./tz.ts";

type Reminder = {
  id: string;
  owner: string;
  due: number;
  message: string;
  channel?: string;
  source?: string;
  repeat: number;
  task: string;
  /** Zone of a repeating reminder: whole days repeat at its local time of `anchor`. */
  zone?: string;
  /** Local wall-clock time (ms) of the first occurrence. */
  anchor?: number;
};
const key = (id: string) => "reminder:" + id;
const memberKey = (id: string) => "active:" + id;
const DAY = 86400000;
const none = { everyone: false, roles: false, users: false };
const active = (ctx: Context, owner: string) => ctx.kv.get<string[]>(memberKey(owner));
const read = (ctx: Context, id: string) => ctx.kv.get<Reminder>(key(id));
const zone = async (ctx: Context, owner: string) =>
  (await ctx.kv.get<string>("zone:" + owner)) ?? ctx.config.timeZone;
/** The member may read and write in the channel the bot would post their text in. */
function canPost(member: Member | undefined, channel: Channel) {
  if (!member?.canView(channel)) return false;
  const perms = member.permissionsIn(channel);
  return perms.includes(channel.type === "thread" ? "SendMessagesInThreads" : "SendMessages");
}
/** Discord or the host refused for good: retrying the same request cannot succeed. */
function refusal(error: unknown) {
  if (error instanceof Error && error.name === "CapabilityError") return "missing grant";
  const text = String(error);
  if (/discord: missing permissions|HTTP 403/i.test(text)) return "missing permissions";
  if (/discord: not found|unknown channel|HTTP 404/i.test(text)) return "unknown channel";
  if (/discord: bad request|HTTP 4(?!29)\d\d/i.test(text)) return "rejected message";
  return undefined;
}

async function create(
  ctx: Context,
  i: Interaction,
  r: Omit<Reminder, "id" | "owner" | "task">,
  ticket?: { key: string; version: string },
) {
  if (!ctx.config.enabled) return i.reply(ctx.i18n.t("disabled"));
  // The bot posts the member's text: only where the member could post it themselves.
  if (r.channel && !canPost(i.member, ctx.server.channel({ id: r.channel })))
    return i.reply({ content: ctx.i18n.t("channelDenied"), ephemeral: true });
  const owner = i.user.id,
    indexKey = memberKey(owner);
  const id = String(await ctx.kv.increment("seq"));
  const task = await ctx.schedule.after(Math.max(1, r.due - Date.now()), "deliver", {
    id,
    due: r.due,
  });
  for (let attempt = 0; attempt < 8; attempt++) {
    const entry = await ctx.kv.getEntry(indexKey);
    const ids = (entry?.value ?? []) as string[];
    if (ids.length >= ctx.config.maxActive) break;
    const reminder = { ...r, owner, id, task: task.id };
    const tx = ctx.kv
      .atomic()
      .check(indexKey, entry?.version ?? null)
      .set(indexKey, [...ids, id])
      .set(key(id), reminder);
    if (ticket) {
      if (!(await ctx.kv.get(ticket.key))) {
        await ctx.schedule.cancel(task.id);
        return i.reply({ content: ctx.i18n.t("missing"), ephemeral: true });
      }
      tx.check(ticket.key, ticket.version).delete(ticket.key);
    }
    if ((await tx.commit()).ok)
      return i.reply({
        content: ctx.i18n.t("created", { id, when: stamp(r.due) }),
        ephemeral: true,
      });
  }
  await ctx.schedule.cancel(task.id);
  await i.reply({ content: ctx.i18n.t("limit"), ephemeral: true });
}

function stamp(at: number) {
  return `<t:${Math.floor(at / 1000)}:F>`;
}

async function remove(ctx: Context, owner: string, id: string) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const e = await ctx.kv.getEntry(memberKey(owner)),
      r = await ctx.kv.getEntry(key(id));
    if (!r || (r.value as Reminder).owner !== owner) return false;
    const ids = (e?.value ?? []) as string[];
    const tx = ctx.kv
      .atomic()
      .check(memberKey(owner), e?.version ?? null)
      .check(key(id), r.version)
      .set(
        memberKey(owner),
        ids.filter((x) => x !== id),
      )
      .delete(key(id));
    if ((await tx.commit()).ok) {
      await ctx.schedule.cancel((r.value as Reminder).task);
      return true;
    }
  }
  throw Error("Reminder index changed repeatedly");
}

async function deliver(ctx: Context, payload: Json | undefined) {
  if (!ctx.config.enabled) return;
  const p = payload as { id: string; due: number };
  const r = await read(ctx, p.id);
  if (!r || r.due !== p.due) return;
  const member = await ctx.server.member(r.owner);
  if (!member || (r.source && !member.canView({ id: r.source }))) {
    await remove(ctx, r.owner, r.id);
    return;
  }
  const channel = r.channel ? ctx.server.channel({ id: r.channel }) : undefined;
  const late = Math.max(0, Math.floor((Date.now() - r.due) / 60000));
  const message = (note?: string) => ({
    content: [r.message, late ? ctx.i18n.t("late", { minutes: late }) : "", note ?? ""]
      .filter(Boolean)
      .join("\n"),
    allowedMentions: none,
    nonce: `r${r.id}-${r.due.toString(36)}`,
    enforceNonce: true,
    components: [
      {
        type: "row" as const,
        components: [10, 60].map((m) => ({
          type: "button" as const,
          style: "secondary" as const,
          id: `snooze:${r.id}:${r.due}:${m}`,
          label: ctx.i18n.t(m === 10 ? "snooze10" : "snooze60"),
        })),
      },
    ],
  });
  // A member who can no longer write in the destination gets the reminder by DM instead.
  let fallback = !!channel && !canPost(member, channel);
  if (channel && !fallback) {
    try {
      await channel.send(message());
      ctx.status.set("channel", null);
    } catch (error) {
      const reason = refusal(error);
      if (!reason) throw error; // ambiguous: retried with the same nonce
      ctx.status.set("channel", ctx.i18n.t("channelRefused", { channel: channel.mention, reason }));
      fallback = true;
    }
  }
  if (!channel || fallback) {
    try {
      await member.send(
        message(
          fallback ? ctx.i18n.t("channelFallback", { channel: `<#${r.channel}>` }) : undefined,
        ),
      );
      ctx.status.set("dm", null);
    } catch (error) {
      const reason = refusal(error);
      if (!reason) throw error;
      // The member does not accept DMs: retrying cannot help, and a dead task would end a
      // repeating reminder. Skip this occurrence and say so.
      ctx.log.warn("reminders: a reminder DM was refused", { reminder: r.id, reason });
      ctx.status.set("dm", ctx.i18n.t("dmRefused", { reason }));
    }
  }
  // Only this member can reuse the button, and only once per delivered occurrence.
  await ctx.kv.set(`snooze:${r.owner}:${r.id}:${r.due}`, r, { ttlSeconds: 86400 });
  if (!r.repeat) {
    await remove(ctx, r.owner, r.id);
    return;
  }
  const due = nextDue(r, Date.now());
  const task = await ctx.schedule.after(Math.max(1, due - Date.now()), "deliver", {
    id: r.id,
    due,
  });
  const current = await ctx.kv.getEntry(key(r.id));
  if (
    !current ||
    (current.value as Reminder).due !== r.due ||
    !(
      await ctx.kv
        .atomic()
        .check(key(r.id), current.version)
        .set(key(r.id), { ...r, due, task: task.id })
        .commit()
    ).ok
  )
    await ctx.schedule.cancel(task.id);
}

async function privateData(ctx: Context, owner: string, erase: boolean) {
  const ids = (await active(ctx, owner)) ?? [];
  const reminders = await Promise.all(ids.map((id) => read(ctx, id)));
  let count = 0;
  const snoozes: Json[] = [];
  let cursor: string | undefined;
  do {
    const page = await ctx.kv.list({ prefix: "snooze:" + owner + ":", limit: 100, cursor });
    for (const item of page.items) {
      snoozes.push(item.value);
      if (erase) {
        await ctx.kv.delete(item.key);
        count++;
      }
    }
    cursor = page.cursor;
  } while (cursor);
  const timeZone = await ctx.kv.get<string>("zone:" + owner);
  if (erase) {
    for (const id of ids) if (await remove(ctx, owner, id)) count++;
    if (timeZone) {
      await ctx.kv.delete("zone:" + owner);
      count++;
    }
    await ctx.kv.delete(memberKey(owner));
  }
  return {
    data: {
      reminders: reminders.filter((r): r is Reminder => !!r),
      snoozes,
      timeZone: timeZone ?? null,
    },
    erased: count,
  };
}

export default definePlugin({
  async onStart(ctx) {
    await ctx.kv.set("meta:schema", 1);
  },
  tasks: { deliver },
  commands: {
    remind: command({
      description: "Manage personal reminders",
      ephemeral: true,
      subcommands: {
        create: subcommand({
          description: "Schedule a reminder",
          options: {
            when: {
              type: "string",
              description: "Date in your time zone or delay",
              required: true,
            },
            message: {
              type: "string",
              description: "Reminder text",
              required: true,
              minLength: 1,
              maxLength: 1500,
            },
            where: {
              type: "string",
              description: "Delivery destination",
              choices: [
                { name: "DM", value: "dm" },
                { name: "Channel", value: "channel" },
              ],
            },
            repeat: { type: "string", description: "Repeat interval such as 2h" },
          },
          async run(ctx, i) {
            const when = parseDate(i.options.when, await zone(ctx, i.user.id));
            const repeat = i.options.repeat ? duration(i.options.repeat) : 0;
            if (
              !when ||
              when <= Date.now() ||
              when > Date.now() + 366 * DAY ||
              repeat === undefined ||
              (repeat > 0 && (repeat < ctx.config.minRepeatMinutes * 60000 || repeat > 366 * DAY))
            )
              return i.reply(ctx.i18n.t("invalid"));
            if (i.options.where === "channel" && !i.channel) return i.reply(ctx.i18n.t("invalid"));
            const tz = await zone(ctx, i.user.id);
            await create(ctx, i, {
              due: when,
              message: i.options.message,
              repeat,
              // The zone at creation keeps a daily or weekly reminder on its local time.
              ...(repeat ? { zone: tz, anchor: localMs(tz, when) } : {}),
              ...(i.options.where === "channel" ? { channel: i.channel!.id } : {}),
            });
          },
        }),
        list: subcommand({
          description: "List your active reminders",
          async run(ctx, i) {
            const ids = (await active(ctx, i.user.id)) ?? [],
              rows = await Promise.all(ids.map((id) => read(ctx, id)));
            await i.reply({
              content:
                rows
                  .filter((r): r is Reminder => !!r)
                  .map((r) => `#${r.id} ${stamp(r.due)} · ${r.message.slice(0, 90)}`)
                  .join("\n")
                  .slice(0, 1999) || ctx.i18n.t("empty"),
              allowedMentions: none,
              ephemeral: true,
            });
          },
        }),
        cancel: subcommand({
          description: "Cancel your reminder",
          options: {
            id: {
              type: "string",
              description: "Reminder number",
              required: true,
              autocomplete: async (ctx, i, f) =>
                ((await active(ctx, i.user.id)) ?? [])
                  .filter((id) => id.startsWith(f.value))
                  .slice(0, 25)
                  .map((id) => ({ name: "#" + id, value: id })),
            },
          },
          async run(ctx, i) {
            await i.reply(
              ctx.i18n.t((await remove(ctx, i.user.id, i.options.id)) ? "cancelled" : "missing"),
            );
          },
        }),
      },
    }),
    timezone: command({
      description: "Manage your time zone",
      ephemeral: true,
      subcommands: {
        set: subcommand({
          description: "Set your time zone",
          options: {
            zone: {
              type: "string",
              description: "Time zone",
              required: true,
              autocomplete: (_ctx, _i, f) =>
                Object.keys(ZONES)
                  .filter((z) => z.toLowerCase().includes(f.value.toLowerCase()))
                  .slice(0, 25)
                  .map((z) => ({ name: z, value: z })),
            },
          },
          async run(ctx, i) {
            if (!ctx.config.enabled || !Object.hasOwn(ZONES, i.options.zone))
              return i.reply(ctx.i18n.t("invalid"));
            await ctx.kv.set("zone:" + i.user.id, i.options.zone);
            await i.reply(ctx.i18n.t("saved"));
          },
        }),
      },
    }),
  },
  contextMenus: {
    "Remind me": {
      type: "message",
      async run(ctx, i) {
        if (!i.member?.canView(i.target.channel))
          return i.reply({ content: ctx.i18n.t("missing"), ephemeral: true });
        await create(ctx, i, {
          due: Date.now() + 3600000,
          message: i.target.url,
          source: i.target.channel.id,
          repeat: 0,
        });
      },
    },
  },
  components: {
    async snooze(ctx, i) {
      const [, id, due, minutes] = i.componentId.split(":");
      if (!id || !due || !["10", "60"].includes(minutes ?? "")) return;
      const k = `snooze:${i.user.id}:${id}:${due}`,
        e = await ctx.kv.getEntry(k);
      if (!e) return i.reply({ content: ctx.i18n.t("missing"), ephemeral: true });
      const r = e.value as Reminder;
      await create(
        ctx,
        i,
        {
          message: r.message,
          due: Date.now() + Number(minutes) * 60000,
          repeat: 0,
          ...(r.channel ? { channel: r.channel } : {}),
          ...(r.source ? { source: r.source } : {}),
        },
        { key: k, version: e.version },
      );
    },
  },
  queries: {
    timezone: {
      async run(ctx, input: { userId: string }, call) {
        if (call.onBehalfOf && call.onBehalfOf.userId !== input.userId) return {};
        const timeZone = await ctx.kv.get<string>("zone:" + input.userId);
        return timeZone ? { timeZone } : {};
      },
    },
  },
  privacy: {
    async export(ctx, id) {
      return (await privateData(ctx, id, false)).data;
    },
    async erase(ctx, id) {
      return { erased: (await privateData(ctx, id, true)).erased };
    },
  },
});
