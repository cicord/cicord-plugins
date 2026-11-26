import {
  action,
  command,
  definePlugin,
  defineRoutes,
  query,
  subcommand,
  type Context,
  type Interaction,
  type Json,
} from "@cicord/sdk";
import { balanceKey, inventoryPrefix, pay, transact, type Order, type Product } from "./ledger.ts";
import type { LedgerRow, Routes } from "./routes.ts";
import type { Movement } from "./contracts.ts";

const t = (ctx: Context, k: string, vars: Record<string, string | number> = {}) =>
  ctx.i18n.t(k, vars);
const member = { type: "user", required: true, description: "Member" } as const;
const amount = {
  type: "integer",
  required: true,
  min: 1,
  max: 1000000000,
  description: "Points",
} as const;
async function replyBalance(ctx: Context, i: Interaction, op: () => Promise<number>) {
  try {
    await i.reply(t(ctx, "balance", { balance: await op() }));
  } catch (e) {
    const code = e instanceof Error ? e.message : String(e);
    if (!["funds", "invalid", "claimed", "off", "recent"].includes(code)) throw e;
    await i.reply(t(ctx, code));
  }
}
const balance = (ctx: Context, uid: string) =>
  ctx.kv.get<number>(balanceKey(uid)).then((n) => n ?? 0);
const claim = (period: "daily" | "weekly") =>
  command({
    description: "Claim " + period + " points",
    ephemeral: true,
    async run(ctx, i) {
      await replyBalance(ctx, i, () =>
        transact(ctx, i.id, [{ userId: i.user.id, amount: ctx.config[period] }], period, {
          claim: period,
        }),
      );
    },
  });
const admin = (mode: "give" | "take" | "set") =>
  subcommand({
    description: mode + " server points",
    options: { member, amount: { ...amount, min: mode === "set" ? 0 : 1 } },
    async run(ctx, i) {
      if (
        !i.member?.permissions?.some((p) => p === "Administrator" || p === "ManageServer") &&
        i.member?.access !== "admin"
      )
        return i.reply(t(ctx, "denied"));
      await replyBalance(ctx, i, () =>
        transact(
          ctx,
          i.id,
          [
            {
              userId: i.options.member.id,
              amount: (mode === "take" ? -1 : 1) * i.options.amount,
              set: mode === "set",
            },
          ],
          "admin " + mode,
        ),
      );
    },
  });
function available(ctx: Context, p: Product) {
  if (p.type === "role") return !!p.role && ctx.features.enabled("permanentRole");
  if (p.type === "temporary")
    return !!p.role && ctx.features.enabled("temporaryRole") && ctx.plugins.has("member-roles");
  return p.type === "perk" && ctx.features.enabled("perk") && ctx.plugins.has("tickets");
}
async function fulfill(ctx: Context, order: Order) {
  if (!ctx.config.enabled || order.state === "delivered") return;
  const { id, userId, item } = order;
  if (!available(ctx, item)) throw new Error("Product provider unavailable: " + item.id);
  if (item.type === "role") {
    const m = await ctx.server.member(userId);
    if (!m) throw new Error("Purchaser unavailable");
    if (!m.hasRole(item.role!)) await m.addRole(item.role!, "economy order " + id);
  } else if (item.type === "temporary")
    await ctx.plugins.call(
      "member-roles",
      "grantTemporary",
      { userId, role: item.role!, durationSeconds: item.durationSeconds },
      { idempotencyKey: "order:" + id },
    );
  else
    await ctx.plugins.call(
      "tickets",
      "open",
      { userId, subject: item.label, description: "Store order " + id },
      { idempotencyKey: "order:" + id },
    );
  await ctx.kv.set(inventoryPrefix(userId) + id, { ...order, state: "delivered" });
}
type Rule = "level" | "birthday" | "star" | "suggestion" | "poll" | "attendee" | "ticket";
const earn = (ctx: Context, id: string, uid: string, reward: number, reason: string) =>
  transact(ctx, id, [{ userId: uid, amount: reward }], reason, { earned: true });
const handler =
  (rule: Rule, field: string) => async (ctx: Context, input: Json, meta?: { id: string }) => {
    const data = input as Record<string, Json>,
      rate = ctx.config.earnings[rule];
    if (
      !ctx.config.enabled ||
      !rate ||
      !ctx.features.enabled("eventRewards") ||
      (rule === "suggestion" && data.status !== "approved")
    )
      return;
    const origin = meta?.id;
    if (!origin) throw new Error("Missing event receipt");
    if (rule === "poll" && data.votersTruncated) {
      if (!ctx.features.enabled("pollPages")) throw new Error("Missing polls.voters grant");
      await ctx.schedule.after(1, "voters", { origin, pollId: data.pollId!, rate });
      return;
    }
    const targets = data[field],
      ids = Array.isArray(targets) ? targets : [targets];
    for (let n = 0; n < ids.length; n += 50) {
      const batch = ids.slice(n, n + 50).filter((v): v is string => typeof v === "string");
      if (batch.length === 1) await earn(ctx, origin, batch[0]!, rate, rule);
      else if (batch.length)
        await ctx.schedule.after(1, "batch", { origin, ids: batch, rate, rule });
    }
  };
const movement = (direction: number) =>
  action({
    async run(ctx, input: Movement, call) {
      if (!Number.isSafeInteger(input.amount) || input.amount < 1) throw new Error("invalid");
      return {
        balance: await transact(
          ctx,
          "action:" + call.idempotencyKey,
          [{ userId: input.userId, amount: direction * input.amount }],
          input.reason ?? (direction === 1 ? "credit" : "debit"),
        ),
      };
    },
  });
async function history(ctx: Context, prefix: string, cursor?: string) {
  if (!ctx.config.enabled) return { items: [] };
  const page = await ctx.kv.list<LedgerRow>({ prefix, cursor, limit: 50 });
  return { items: page.items.map((e) => e.value), cursor: page.cursor };
}
async function pending(ctx: Context, cursor?: string) {
  if (!ctx.config.enabled) return;
  const p = await ctx.kv.list<Order>({ prefix: "order:", limit: 200, cursor });
  for (const e of p.items)
    if (e.value.state === "pending") await ctx.schedule.after(1, "fulfill", { key: e.key });
  if (p.cursor) await ctx.schedule.after(1, "pending", { cursor: p.cursor });
}
export default definePlugin({
  async onStart(ctx) {
    if (ctx.config.enabled) await ctx.schedule.after(1, "pending");
  },
  schedules: { orders: { cron: "0 * * * *", run: (ctx) => pending(ctx) } },
  commands: {
    balance: command({
      description: "View a server wallet",
      ephemeral: true,
      options: { member: { ...member, required: false } },
      async run(ctx, i) {
        await i.reply(
          ctx.config.enabled
            ? t(ctx, "balance", { balance: await balance(ctx, i.options.member?.id ?? i.user.id) })
            : t(ctx, "off"),
        );
      },
    }),
    daily: claim("daily"),
    weekly: claim("weekly"),
    pay: command({
      description: "Transfer server points",
      ephemeral: true,
      options: { member, amount },
      async run(ctx, i) {
        if (
          !i.member ||
          Date.now() - i.member.joinedAt.getTime() < ctx.config.minimumDays * 86400000
        )
          return i.reply(t(ctx, "recent"));
        await replyBalance(ctx, i, () =>
          pay(ctx, i.id, i.user.id, i.options.member.id, i.options.amount),
        );
      },
    }),
    leaderboard: command({
      description: "View the top server wallets",
      async run(ctx, i) {
        if (!ctx.config.enabled) return i.reply(t(ctx, "off"));
        const rows = await ctx.kv.ranking("wealth").top({ limit: 25 });
        await i.reply({
          content:
            rows.map((e) => `#${e.rank} <@${e.member}> · ${e.score}`).join("\n") || t(ctx, "empty"),
          allowedMentions: { users: [] },
        });
      },
    }),
    eco: command({
      description: "Manage server points",
      ephemeral: true,
      permissions: ["ManageServer"],
      subcommands: { give: admin("give"), take: admin("take"), set: admin("set") },
    }),
    shop: command({
      description: "Browse reward items",
      ephemeral: true,
      async run(ctx, i) {
        if (!ctx.config.enabled) return i.reply(t(ctx, "off"));
        await i.reply(
          ctx.config.shop
            .filter((p) => available(ctx, p))
            .map((p) => t(ctx, "item", { label: p.label, price: p.price, id: p.id }))
            .join("\n")
            .slice(0, 1900) || t(ctx, "empty"),
        );
      },
    }),
    buy: command({
      description: "Buy a reward",
      ephemeral: true,
      options: { item: { type: "string", required: true, description: "Product ID" } },
      async run(ctx, i) {
        const product = ctx.config.shop.find((p) => p.id === i.options.item);
        if (!ctx.config.enabled || !product || !available(ctx, product))
          return i.reply(t(ctx, "unavailable"));
        try {
          await transact(
            ctx,
            i.id,
            [{ userId: i.user.id, amount: -product.price }],
            "purchase " + product.id,
            { product },
          );
        } catch (e) {
          if (e instanceof Error && e.message === "funds") return i.reply(t(ctx, "funds"));
          throw e;
        }
        await ctx.schedule.after(1, "fulfill", { key: inventoryPrefix(i.user.id) + i.id });
        await i.reply(t(ctx, "pending"));
      },
    }),
    inventory: command({
      description: "View purchased rewards",
      ephemeral: true,
      async run(ctx, i) {
        if (!ctx.config.enabled) return i.reply(t(ctx, "off"));
        const p = await ctx.kv.list<Order>({ prefix: inventoryPrefix(i.user.id), limit: 25 });
        await i.reply(
          p.items.map((o) => o.value.item.label + " · " + o.value.state).join("\n") ||
            t(ctx, "empty"),
        );
      },
    }),
  },
  actions: { credit: movement(1), debit: movement(-1) },
  queries: {
    balance: query({
      async run(ctx, input: { userId: string }) {
        return { balance: ctx.config.enabled ? await balance(ctx, input.userId) : 0 };
      },
    }),
  },
  events: {
    async messageCreate(ctx, m) {
      if (
        ctx.config.enabled &&
        ctx.config.earnings.message &&
        ctx.features.enabled("messageRewards") &&
        !m.author.bot
      )
        await transact(
          ctx,
          "msg:" + m.id,
          [{ userId: m.author.id, amount: ctx.config.earnings.message }],
          "message",
          { earned: true, cooldown: ctx.config.cooldownSeconds },
        );
    },
    async voiceStateUpdate(ctx, v) {
      if (
        !ctx.config.enabled ||
        !ctx.config.earnings.voice ||
        !ctx.features.enabled("voiceRewards") ||
        v.user.bot
      )
        return;
      const k = "voice:" + v.user.id;
      if (v.channel?.id === (await ctx.kv.get(k))) return;
      if (!v.channel) {
        await ctx.kv.delete(k);
        return;
      }
      await ctx.kv.set(k, v.channel.id);
      await ctx.schedule.after(60000, "voice", {
        uid: v.user.id,
        channel: v.channel.id,
        minute: Math.floor(Date.now() / 60000) + 1,
      });
    },
  },
  tasks: {
    async pending(ctx, p) {
      await pending(ctx, (p as { cursor?: string } | undefined)?.cursor);
    },
    async voice(ctx, p) {
      const { uid, channel, minute } = p as { uid: string; channel: string; minute: number };
      if (
        !ctx.config.enabled ||
        !ctx.config.earnings.voice ||
        (await ctx.kv.get("voice:" + uid)) !== channel
      )
        return;
      if (!(await ctx.server.voiceMembers({ id: channel })).some((m) => m.id === uid)) return;
      await earn(ctx, "voice:" + minute, uid, ctx.config.earnings.voice, "voice");
      await ctx.schedule.after(60000, "voice", {
        uid,
        channel,
        minute: Math.floor(Date.now() / 60000) + 1,
      });
    },
    async fulfill(ctx, p) {
      const order = await ctx.kv.get<Order>((p as { key: string }).key);
      if (order) await fulfill(ctx, order);
    },
    async batch(ctx, p) {
      const { origin, ids, rate, rule } = p as {
        origin: string;
        ids: string[];
        rate: number;
        rule: string;
      };
      if (ctx.config.enabled) for (const uid of ids) await earn(ctx, origin, uid, rate, rule);
    },
    async voters(ctx, p) {
      if (!ctx.config.enabled) return;
      const v = p as { origin: string; pollId: string; cursor?: string; rate: number };
      const page = (await ctx.plugins.query("polls", "voters", {
        pollId: v.pollId,
        ...(v.cursor ? { cursor: v.cursor } : {}),
      })) as { userIds: string[]; cursor?: string };
      for (let n = 0; n < page.userIds.length; n += 50)
        await ctx.schedule.after(1, "batch", {
          origin: v.origin,
          ids: page.userIds.slice(n, n + 50),
          rate: v.rate,
          rule: "poll",
        });
      if (page.cursor) await ctx.schedule.after(1, "voters", { ...v, cursor: page.cursor });
    },
  },
  subscriptions: {
    "levels.levelUp": handler("level", "userId"),
    "birthdays.today": handler("birthday", "userId"),
    "starboard.starred": handler("star", "authorId"),
    "suggestions.statusChanged": handler("suggestion", "authorId"),
    "tickets.closed": handler("ticket", "assignee"),
    "community-events.ended": handler("attendee", "attendees"),
    "polls.closed": handler("poll", "voters"),
  },
  routes: defineRoutes<Routes>({
    "GET /wallet": {
      access: "member",
      async handler(ctx, r) {
        return { balance: ctx.config.enabled ? await balance(ctx, r.viewer!.user.id) : 0 };
      },
    },
    "GET /history": {
      access: "member",
      handler: (ctx, r) => history(ctx, "ledger:" + r.viewer!.user.id + ":", r.query.cursor),
    },
    "GET /ledger": {
      access: "moderator",
      handler: (ctx, r) => history(ctx, "ledger:", r.query.cursor),
    },
    "GET /shop": {
      access: "member",
      async handler(ctx) {
        return {
          items: ctx.config.enabled
            ? ctx.config.shop
                .filter((p) => available(ctx, p))
                .map(({ id, label, price }) => ({ id, label, price }))
            : [],
        };
      },
    },
  }),
  privacy: {
    export: (ctx, uid) => personal(ctx, uid, false),
    async erase(ctx, uid) {
      return { erased: (await personal(ctx, uid, true)).length };
    },
  },
});
async function personal(ctx: Context, uid: string, erase: boolean) {
  const out: { key: string; value: Json }[] = [];
  for (const p of ["balance", "voice", "cool", "claim", "order", "earned", "ledger"]) {
    const prefix = p + ":" + uid;
    let cursor: string | undefined;
    do {
      const page = await ctx.kv.list({
        prefix: p === "balance" || p === "voice" || p === "cool" ? prefix : prefix + ":",
        limit: 300,
        cursor,
      });
      for (const row of page.items)
        if (row.key === prefix || row.key.startsWith(prefix + ":")) {
          out.push(row);
          if (erase) await ctx.kv.delete(row.key);
        }
      cursor = page.cursor;
    } while (cursor);
  }
  if (erase) await ctx.kv.ranking("wealth").remove(uid);
  return out;
}
