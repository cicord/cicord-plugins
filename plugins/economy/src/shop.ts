import type { Context, Json } from "@cicord/sdk";
import { orderKey, pendingKey, transact, type Order, type Product } from "./ledger.ts";

/** An undelivered order is refunded once it is this old (see README, "Shop delivery"). */
export const DELIVERY_HOURS = 72;
/** A refund never races an attempt younger than this (actions time out after 15 s at most). */
export const ATTEMPT_LEASE_MS = 60_000;
const WINDOW_MS = DELIVERY_HOURS * 3_600_000;

/** Why a product cannot be delivered right now, or undefined when it can. */
export function missing(ctx: Context, p: Product): string | undefined {
  if (p.type === "role") {
    if (!p.role) return "no role configured";
    if (!ctx.features.enabled("permanentRole"))
      return "permanentRole not granted (discord.roles.assign, discord.members.read)";
    return undefined;
  }
  if (p.type === "temporary") {
    if (!p.role) return "no role configured";
    if (!ctx.features.enabled("temporaryRole"))
      return "temporaryRole not granted (plugins.call:member-roles.grantTemporary)";
    if (!ctx.plugins.has("member-roles")) return "member-roles not installed";
    return undefined;
  }
  if (p.type === "perk") {
    if (!ctx.features.enabled("perk")) return "perk not granted (plugins.call:tickets.open)";
    if (!ctx.plugins.has("tickets")) return "tickets not installed";
    return undefined;
  }
  return "unknown product type";
}
export const available = (ctx: Context, p: Product) => !missing(ctx, p);

/**
 * A refusal that a retry with the same key cannot change: no provider, a denied call
 * (grant, allow list, erased member, or a provider's own InteropError("denied")), a call
 * cycle or an ambiguous provider configuration. Timeouts and handler errors are retried
 * with the original key, as the interop contract asks.
 */
function definitive(e: unknown) {
  const { name, code } = (e ?? {}) as { name?: string; code?: string };
  if (name === "PluginUnavailableError" || name === "CapabilityError") return true;
  return (
    name === "InteropError" && ["not_found", "denied", "cycle", "ambiguous"].includes(code ?? "")
  );
}
/** First line only: provider handler errors carry stack frames. */
const text = (e: unknown) =>
  (e instanceof Error ? e.name + ": " + e.message : String(e)).split("\n")[0]!.slice(0, 160);

/** Compare-and-set on an order. Leaving the pending state also drops its index row. */
async function patch(ctx: Context, key: string, next: (o: Order) => Order | undefined) {
  for (;;) {
    const e = await ctx.kv.getEntry<Order>(key);
    if (!e) return undefined;
    const value = next(e.value);
    if (!value) return e.value;
    const a = ctx.kv
      .atomic()
      .check(key, e.version)
      .set(key, value as Json);
    if (value.state !== "pending") a.delete(pendingKey(key));
    if ((await a.commit()).ok) return value;
  }
}
/** One commit: the order becomes refunded, the price returns to the wallet with a journal row. */
async function refund(
  ctx: Context,
  key: string,
  reason: string,
  allow: (o: Order) => boolean = () => true,
) {
  const o = await ctx.kv.get<Order>(key);
  if (!o || o.state !== "pending") return o;
  await transact(
    ctx,
    "refund:" + o.id,
    [{ userId: o.userId, amount: o.item.price }],
    "refund " + o.item.id,
    {
      refund: { key, allow },
    },
  );
  const after = await ctx.kv.get<Order>(key);
  if (after?.state === "refunded")
    ctx.status.set(
      "orders",
      ("Refunded an undelivered " + o.item.id + " order: " + reason).slice(0, 300),
    );
  return after;
}
async function effect(ctx: Context, o: Order) {
  const { id, userId, item } = o;
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
      { userId, subject: o.ticket!.subject, description: o.ticket!.description },
      { idempotencyKey: "order:" + id },
    );
}
export const ticketInput = (ctx: Context, o: Pick<Order, "id" | "item">) => ({
  subject: o.item.label,
  description: ctx.i18n.t("perk.description", { id: o.id }),
});

/**
 * Delivers a pending order. `member` runs inside the purchaser's interaction or portal
 * route, where the host attaches the member as `call.onBehalfOf`; `background` runs in a
 * task, which carries no principal, so it never calls tickets.open: a perk is delivered
 * only by a member attempt, and a background pass only refunds it after the window.
 */
export async function deliver(
  ctx: Context,
  key: string,
  mode: "member" | "background",
): Promise<Order | undefined> {
  if (!ctx.config.enabled) return ctx.kv.get<Order>(key);
  const entry = await ctx.kv.getEntry<Order>(key);
  if (!entry || entry.value.state !== "pending") return entry?.value;
  const order = entry.value,
    now = Date.now();
  const idle = (o: Order) => !o.attemptAt || Date.now() - o.attemptAt >= ATTEMPT_LEASE_MS;
  const reason = missing(ctx, order.item);
  if (reason) return refund(ctx, key, reason, idle);
  if (mode === "background") {
    if (order.createdAt === undefined)
      return patch(ctx, key, (o) =>
        o.state === "pending" && o.createdAt === undefined ? { ...o, createdAt: now } : undefined,
      );
    if (now - order.createdAt >= WINDOW_MS)
      return refund(ctx, key, "undelivered after " + DELIVERY_HOURS + " h", idle);
    if (order.item.type === "perk") return order;
  }
  const attempt: Order = {
    ...order,
    createdAt: order.createdAt ?? now,
    attemptAt: now,
    attempts: (order.attempts ?? 0) + 1,
    ...(order.item.type === "perk" ? { ticket: order.ticket ?? ticketInput(ctx, order) } : {}),
  };
  const claimed = await ctx.kv
    .atomic()
    .check(key, entry.version)
    .set(key, attempt as Json)
    .commit();
  // Another attempt or a refund changed the order first; report its current state.
  if (!claimed.ok) return ctx.kv.get<Order>(key);
  try {
    await effect(ctx, attempt);
  } catch (e) {
    if (definitive(e)) return refund(ctx, key, text(e));
    const error = text(e);
    ctx.status.set(
      "orders",
      (
        "Undelivered " +
        order.item.id +
        " order (" +
        error +
        "). The member can retry with /buy or /inventory; it is refunded after " +
        DELIVERY_HOURS +
        " h."
      ).slice(0, 300),
    );
    return patch(ctx, key, (o) => (o.state === "pending" ? { ...o, error } : undefined));
  }
  return patch(ctx, key, (o) => {
    if (o.state !== "pending") return undefined;
    const { error: _, ...rest } = o;
    return { ...rest, state: "delivered" };
  });
}
/** The member's undelivered orders (bounded). */
export async function pendingOrders(ctx: Context, uid: string, limit = 25) {
  const page = await ctx.kv.list({ prefix: pendingKey(orderKey(uid, "")), limit });
  const keys = page.items.map((e) => e.key.slice("pend:".length));
  const orders = await ctx.kv.getMany<Order>(keys);
  return keys.flatMap((key, n) =>
    orders[n]?.state === "pending" ? [{ key, order: orders[n]! }] : [],
  );
}
/** A purchase id that was redirected to an earlier pending order of the same product. */
export const aliasKey = (uid: string, id: string) => "alias:" + uid + ":" + id;
export async function purchase(
  ctx: Context,
  uid: string,
  itemId: string,
  id: string,
): Promise<{ orderId: string; itemId: string; state: Order["state"] }> {
  if (!ctx.config.enabled) throw new Error("unavailable");
  let key = orderKey(uid, id);
  let order = await ctx.kv.get<Order>(key);
  if (!order) {
    const target = await ctx.kv.get<string>(aliasKey(uid, id));
    if (target) [key, order] = [target, await ctx.kv.get<Order>(target)];
  }
  if (!order) {
    const item = ctx.config.shop.find((p) => p.id === itemId);
    if (!item || !available(ctx, item)) throw new Error("unavailable");
    // An undelivered order of the same product is retried instead of charged again. The
    // alias keeps this purchase id idempotent once that order is delivered or refunded.
    const open = (await pendingOrders(ctx, uid)).find((p) => p.order.item.id === itemId);
    if (open) {
      const linked = await ctx.kv
        .atomic()
        .check(aliasKey(uid, id), null)
        .check(key, null)
        .set(aliasKey(uid, id), open.key)
        .commit();
      // A concurrent replay of this id linked or charged it first: resolve that instead.
      if (!linked.ok) return purchase(ctx, uid, itemId, id);
      ({ key, order } = open);
    } else {
      const created: Order = { id, userId: uid, item, state: "pending" };
      if (item.type === "perk") created.ticket = ticketInput(ctx, created);
      await transact(ctx, id, [{ userId: uid, amount: -item.price }], "purchase " + item.id, {
        order: created,
      });
      order = await ctx.kv.get<Order>(key);
    }
  }
  if (!order || order.item.id !== itemId) throw new Error("purchase_conflict");
  if (order.state === "pending") order = (await deliver(ctx, key, "member")) ?? order;
  return { orderId: order.id, itemId: order.item.id, state: order.state };
}
/** Hourly: revisit one bounded page of the pending index per task. */
export async function pendingPass(ctx: Context, cursor?: string) {
  if (!ctx.config.enabled) return;
  const p = await ctx.kv.list({ prefix: "pend:", limit: 200, cursor });
  if (!cursor && !p.items.length) ctx.status.set("orders", null);
  for (const e of p.items)
    await ctx.schedule.after(1, "fulfill", { key: e.key.slice("pend:".length) });
  if (p.cursor) await ctx.schedule.after(1, "pending", { cursor: p.cursor });
}
export async function fulfillTask(ctx: Context, key: string) {
  const order = await deliver(ctx, key, "background");
  // Heal an index row that outlived its order (for example one written by the backfill).
  if (order?.state !== "pending") await ctx.kv.delete(pendingKey(key));
}
/** Indexes pending orders written before the pending index existed, one page per task. */
export async function backfill(ctx: Context, cursor?: string) {
  if (!ctx.config.enabled || (await ctx.kv.get("migr:pending-index"))) return;
  const p = await ctx.kv.list<Order>({ prefix: "order:", limit: 200, cursor });
  for (const e of p.items)
    if (e.value.state === "pending") await ctx.kv.set(pendingKey(e.key), Date.now());
  if (p.cursor) await ctx.schedule.after(1, "backfill", { cursor: p.cursor });
  else await ctx.kv.set("migr:pending-index", true);
}
