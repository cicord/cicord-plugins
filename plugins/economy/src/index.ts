import {
  action,
  command,
  definePlugin,
  defineRoutes,
  InteropError,
  query,
  subcommand,
  type Context,
  type Interaction,
  type Json,
} from "@cicord/sdk";
import { balanceKey, inventoryPrefix, pay, transact, type Order } from "./ledger.ts";
import type { LedgerRow, Routes } from "./routes.ts";
import type { Movement } from "./contracts.ts";
import {
  available,
  backfill,
  deliver,
  fulfillTask,
  missing,
  pendingOrders,
  pendingPass,
  purchase,
} from "./shop.ts";

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
type Rule = "level" | "birthday" | "star" | "suggestion" | "poll" | "attendee" | "ticket";
const earn = (ctx: Context, id: string, uid: string, reward: number, reason: string) =>
  transact(ctx, id, [{ userId: uid, amount: reward }], reason, { earned: true });
const handler =
  (rule: Rule, field: string) =>
  async (
    ctx: Context,
    input: Json,
    meta?: { id: string; publisher?: { bot: string; instance: string } },
  ) => {
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
    if (rule === "poll" && data.votersTruncated && !ctx.features.enabled("pollPages"))
      // P10: pay the voters the event carries and say why the others are not paid.
      ctx.status.set(
        "poll-voters",
        "A closed poll had more voters than its event carries; only those were paid. Grant plugins.query:polls.voters (pollPages) to pay every voter.",
      );
    else if (rule === "poll" && data.votersTruncated) {
      if (!meta?.publisher) throw new Error("Missing poll publisher for voter rewards");
      await ctx.schedule.after(1, "voters", {
        origin,
        pollId: data.pollId!,
        rate,
        publisher: { bot: meta.publisher.bot, instance: meta.publisher.instance },
      });
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
      // A debit spends a member's points: only that member, through a consumer's
      // interaction or member route, may authorize it. Background callers can only credit.
      if (
        direction < 0 &&
        (call.onBehalfOf?.userId !== input.userId || call.onBehalfOf.access === "scoped")
      )
        throw new InteropError("denied", "A debit must be made on behalf of the debited member");
      return {
        balance: await transact(
          ctx,
          "action:" +
            (direction > 0 ? "credit:" : "debit:") +
            call.caller.bot +
            "/" +
            call.caller.instance +
            ":" +
            call.idempotencyKey,
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
const publishers: Record<Rule, string> = {
  level: "levels",
  birthday: "birthdays",
  star: "starboard",
  suggestion: "suggestions",
  poll: "polls",
  attendee: "community-events",
  ticket: "tickets",
};
/** P10: name every configured product or reward source that cannot work, and what it lacks. */
function reportStatus(ctx: Context) {
  const line = (head: string, parts: string[]) =>
    parts.length ? (head + parts.join("; ")).slice(0, 300) : null;
  const enabled = ctx.config.enabled;
  ctx.status.set(
    "shop-products",
    line(
      "Unavailable shop products: ",
      enabled
        ? ctx.config.shop.flatMap((p) => {
            const why = missing(ctx, p);
            return why ? [p.id + " (" + why + ")"] : [];
          })
        : [],
    ),
  );
  const inactive: string[] = [];
  const e = ctx.config.earnings;
  if (enabled && e.message && !ctx.features.enabled("messageRewards"))
    inactive.push("message (messageRewards: ServerMessages intent not enabled)");
  if (enabled && e.voice && !ctx.features.enabled("voiceRewards"))
    inactive.push(
      "voice (voiceRewards: ServerVoiceStates intent, discord.members.read and discord.channels.read)",
    );
  const rules = enabled ? (Object.keys(publishers) as Rule[]).filter((r) => e[r]) : [];
  if (rules.length && !ctx.features.enabled("eventRewards"))
    inactive.push(rules.join(", ") + " (eventRewards: events.subscribe not granted)");
  else
    for (const r of rules)
      if (!ctx.plugins.has(publishers[r]))
        inactive.push(r + " (" + publishers[r] + " not installed)");
  if (
    rules.includes("poll") &&
    ctx.features.enabled("eventRewards") &&
    !ctx.features.enabled("pollPages")
  )
    inactive.push("voters beyond a poll event's list (pollPages: plugins.query:polls.voters)");
  ctx.status.set("rewards", line("Inactive rewards: ", inactive));
  if (!enabled || ctx.features.enabled("pollPages")) ctx.status.set("poll-voters", null);
}
export default definePlugin({
  async onStart(ctx) {
    reportStatus(ctx);
    if (!ctx.config.enabled) return;
    await ctx.schedule.after(1, "pending");
    if (!(await ctx.kv.get("migr:pending-index"))) await ctx.schedule.after(1, "backfill");
  },
  schedules: { orders: { cron: "0 * * * *", run: (ctx) => pendingPass(ctx) } },
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
        // Delivery runs here, where the host attaches the buyer as the call principal.
        await i.defer({ ephemeral: true });
        try {
          const order = await purchase(ctx, i.user.id, i.options.item, i.id);
          await i.reply(t(ctx, "bought." + order.state, { id: order.itemId }));
        } catch (e) {
          if (e instanceof Error && ["funds", "unavailable"].includes(e.message))
            return i.reply(t(ctx, e.message));
          throw e;
        }
      },
    }),
    inventory: command({
      description: "View purchased rewards",
      ephemeral: true,
      async run(ctx, i) {
        if (!ctx.config.enabled) return i.reply(t(ctx, "off"));
        await i.defer({ ephemeral: true });
        await retryDeliveries(ctx, i.user.id);
        const p = await ctx.kv.list<Order>({ prefix: inventoryPrefix(i.user.id), limit: 25 });
        await i.reply(
          p.items
            .map((o) => o.value.item.label + " · " + t(ctx, "state." + o.value.state))
            .join("\n") || t(ctx, "empty"),
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
      // The session is `<channel>:<join token>`: a chain only continues while it holds the
      // current token, so leaving and rejoining leaves exactly one live chain.
      const session = await ctx.kv.get<string>(k);
      // A value without a token predates tokens: its chain has stopped, so start a new one.
      if (v.channel && session?.includes(":") && session.split(":")[0] === v.channel.id) return;
      if (!v.channel) {
        await ctx.kv.delete(k);
        return;
      }
      const token = v.channel.id + ":" + crypto.randomUUID();
      await ctx.kv.set(k, token);
      await ctx.schedule.after(60000, "voice", {
        uid: v.user.id,
        channel: v.channel.id,
        token,
        minute: Math.floor(Date.now() / 60000) + 1,
      });
    },
  },
  tasks: {
    async pending(ctx, p) {
      await pendingPass(ctx, (p as { cursor?: string } | undefined)?.cursor);
    },
    async backfill(ctx, p) {
      await backfill(ctx, (p as { cursor?: string } | undefined)?.cursor);
    },
    async voice(ctx, p) {
      const { uid, channel, token, minute } = p as {
        uid: string;
        channel: string;
        token?: string;
        minute: number;
      };
      if (
        !ctx.config.enabled ||
        !ctx.config.earnings.voice ||
        !token ||
        (await ctx.kv.get("voice:" + uid)) !== token
      )
        return;
      if (!(await ctx.server.voiceMembers({ id: channel })).some((m) => m.id === uid)) return;
      await earn(ctx, "voice:" + minute, uid, ctx.config.earnings.voice, "voice");
      await ctx.schedule.after(60000, "voice", {
        uid,
        channel,
        token,
        minute: Math.floor(Date.now() / 60000) + 1,
      });
    },
    async fulfill(ctx, p) {
      await fulfillTask(ctx, (p as { key: string }).key);
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
      const v = p as {
        origin: string;
        pollId: string;
        cursor?: string;
        publisher?: { bot: string; instance: string };
        rate: number;
      };
      if (!v.publisher) throw new Error("Missing poll publisher for voter rewards");
      const page = (await ctx.plugins.query("polls", "voters", {
        pollId: v.pollId,
        publisher: v.publisher,
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
    "POST /shop/:id/buy": {
      access: "member",
      async handler(ctx, r) {
        const token = r.body?.purchaseId;
        if (
          typeof token !== "string" ||
          !/^[a-f0-9]{8}-[a-f0-9]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token)
        )
          return { status: 400, body: { error: "invalid_purchase_id" } };
        const uid = r.viewer!.user.id;
        try {
          return await purchase(ctx, uid, r.params.id, "portal:" + uid + ":" + token.toLowerCase());
        } catch (e) {
          const code = e instanceof Error ? e.message : String(e);
          if (code === "unavailable") return { status: 404, body: { error: code } };
          if (code === "funds" || code === "purchase_conflict")
            return { status: 409, body: { error: code } };
          throw e;
        }
      },
    },
    "POST /inventory/deliver": {
      access: "member",
      async handler(ctx, r) {
        if (!ctx.config.enabled) return { items: [] };
        return { items: await retryDeliveries(ctx, r.viewer!.user.id) };
      },
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
  // Receipts (`rcpt:<digest>`) carry no member id and are kept so replays stay idempotent.
  for (const p of [
    "balance",
    "voice",
    "cool",
    "claim",
    "order",
    "pend:order",
    "alias",
    "earned",
    "ledger",
  ]) {
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
/**
 * Member-initiated retry of up to three undelivered orders, with the original keys. An
 * action can take 5 s, so no new attempt starts after 4 s: the handler deadline is 10 s.
 */
async function retryDeliveries(ctx: Context, uid: string) {
  const out: { orderId: string; itemId: string; state: Order["state"] }[] = [];
  const start = Date.now();
  for (const { key, order } of await pendingOrders(ctx, uid, 3)) {
    if (Date.now() - start > 4000) break;
    const now = (await deliver(ctx, key, "member")) ?? order;
    out.push({ orderId: now.id, itemId: now.item.id, state: now.state });
  }
  return out;
}
