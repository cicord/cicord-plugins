import type { Context, Json } from "@cicord/sdk";
import sha from "./fast-sha256/sha256.cjs";
import type { LedgerRow } from "./routes.ts";
import { offsetAt } from "./timezone.ts";

declare const TextEncoder: { new (): { encode(value: string): Uint8Array } };

export const dayNumber = (ctx: Context, now = Date.now()) =>
  Math.floor((now + 60000 * offsetAt(ctx.config.timezone, now)) / 86400000);
export type Product = {
  id: string;
  label: string;
  price: number;
  type: string;
  role?: string;
  durationSeconds: number;
};
type Change = { userId: string; amount: number; set?: boolean };
export type Order = {
  userId: string;
  id: string;
  item: Product;
  state: "pending" | "delivered" | "refunded";
  /** Start of the delivery window. */
  createdAt?: number;
  /** Start of the latest delivery attempt; a refund waits until it is older than the action deadline. */
  attemptAt?: number;
  attempts?: number;
  error?: string;
  /** The exact tickets.open input, frozen at purchase so every retry carries the same fingerprint. */
  ticket?: { subject: string; description: string };
};
type Options = {
  claim?: "daily" | "weekly";
  earned?: boolean;
  cooldown?: number;
  /** Creates this pending order (and its pending index row) in the same commit. */
  order?: Order;
  /** Moves this pending order to refunded in the same commit, if `allow` accepts it. */
  refund?: { key: string; allow: (order: Order) => boolean };
};
export const balanceKey = (uid: string) => "balance:" + uid;
export const inventoryPrefix = (uid: string) => "order:" + uid + ":";
export const orderKey = (uid: string, id: string) => inventoryPrefix(uid) + id;
/** Index of undelivered orders: `pend:<order key>`. Only these are revisited by the cron. */
export const pendingKey = (key: string) => "pend:" + key;
/** Receipts outlive journal rows and erasure, well beyond the host's 30-day action and event horizons. */
export const RECEIPT_DAYS = 400;
const hex = (bytes: Uint8Array) => [...bytes].map((n) => n.toString(16).padStart(2, "0")).join("");
/**
 * Idempotency receipt of one operation for one account. The key is a digest and the value
 * a timestamp, so the row carries no member id: erasure keeps it, and a replay of the same
 * event, command or caller key after an erasure or after journal expiry cannot pay twice.
 */
export const receiptKey = (uid: string, id: string) =>
  "rcpt:" + hex(sha(new TextEncoder().encode(uid + "\n" + id))).slice(0, 40);
const current = async (ctx: Context, uid: string) =>
  (await ctx.kv.get<number>(balanceKey(uid))) ?? 0;
/** The receipt, the journal, balances, limits, claim and order changes all commit together. */
export async function transact(
  ctx: Context,
  id: string,
  changes: Change[],
  reason: string,
  options: Options = {},
): Promise<number> {
  if (!ctx.config.enabled) throw new Error("off");
  const uid = changes[0]!.userId;
  const transactionId = crypto.randomUUID();
  const rowId = (user: string) => `ledger:${user}:${id}`;
  const receipt = receiptKey(uid, id);
  for (;;) {
    // A journal row written before receipts existed is honored as a receipt too.
    const [prior, legacy] = await ctx.kv.getMany([receipt, rowId(uid)]);
    if (prior !== undefined || legacy !== undefined) {
      await publish(ctx, id, changes);
      return current(ctx, uid);
    }
    const now = Date.now(),
      day = dayNumber(ctx, now);
    const checks = ctx.kv
      .atomic()
      .check(receipt, null)
      .set(receipt, now, { ttlSeconds: Math.max(RECEIPT_DAYS, ctx.config.journalDays) * 86400 });
    const delta = changes.map((e) => ({ ...e }));
    if (options.refund) {
      const { key, allow } = options.refund,
        o = await ctx.kv.getEntry<Order>(key);
      if (!o || o.value.state !== "pending" || !allow(o.value)) return current(ctx, uid);
      checks
        .check(key, o.version)
        .set(key, { ...o.value, state: "refunded" } as Json)
        .delete(pendingKey(key));
    }
    if (options.claim) {
      const ck = `claim:${uid}:${options.claim}`,
        period = options.claim === "daily" ? day : Math.floor((day + 3) / 7);
      const prev = await ctx.kv.getEntry<{ period: number; streak: number }>(ck);
      if (prev && prev.value.period >= period) throw new Error("claimed");
      const streak = prev?.value.period === period - 1 ? prev.value.streak + 1 : 1;
      if (options.claim === "daily")
        delta[0]!.amount +=
          ctx.config.streakBonus * Math.min(streak - 1, ctx.config.streakLimit - 1);
      checks.check(ck, prev?.version ?? null).set(ck, { period, streak });
    }
    if (options.earned) {
      const ek = `earned:${uid}:${day}`,
        earn = await ctx.kv.getEntry<number>(ek);
      if (ctx.config.dailyCap)
        delta[0]!.amount = Math.min(
          delta[0]!.amount,
          Math.max(0, ctx.config.dailyCap - (earn?.value ?? 0)),
        );
      if (!delta[0]!.amount) return current(ctx, uid);
      checks
        .check(ek, earn?.version ?? null)
        .set(ek, (earn?.value ?? 0) + delta[0]!.amount, { ttlSeconds: 172800 });
      if (options.cooldown) {
        const ck = "cool:" + uid,
          prev = await ctx.kv.getEntry<number>(ck);
        if (prev && now - prev.value < options.cooldown * 1000) return current(ctx, uid);
        checks.check(ck, prev?.version ?? null).set(ck, now, { ttlSeconds: options.cooldown });
      }
    }
    let balance = 0;
    for (const [index, change] of delta.entries()) {
      const k = balanceKey(change.userId),
        b = await ctx.kv.getEntry<number>(k),
        before = b?.value ?? 0;
      const after = change.set ? change.amount : before + change.amount;
      if (!Number.isSafeInteger(after) || after < 0) throw new Error("funds");
      const row = {
        id: transactionId,
        userId: change.userId,
        amount: after - before,
        balance: after,
        reason,
        at: now,
      };
      checks
        .check(k, b?.version ?? null)
        .set(k, after)
        .set(rowId(change.userId), row, { ttlSeconds: ctx.config.journalDays * 86400 });
      if (change.userId !== "treasury") {
        if (after) checks.rankSet("wealth", change.userId, after);
        else checks.rankRemove("wealth", change.userId);
      }
      if (index === 0) balance = after;
    }
    if (options.order) {
      const key = orderKey(uid, options.order.id);
      checks
        .check(key, null)
        .set(key, { ...options.order, createdAt: now } as Json)
        .set(pendingKey(key), now);
    }
    if ((await checks.commit()).ok) {
      await publish(ctx, id, changes);
      return balance;
    }
  }
}
async function publish(ctx: Context, id: string, changes: Change[]) {
  for (const { userId } of changes) {
    const row = await ctx.kv.get<LedgerRow>(`ledger:${userId}:${id}`);
    if (row) {
      const { at: _, ...event } = row;
      await ctx.events.publish("transaction", event, { idempotencyKey: `${row.id}:${userId}` });
    }
  }
}
export async function pay(ctx: Context, id: string, from: string, to: string, amount: number) {
  if (to === from || !Number.isSafeInteger(amount) || amount <= 0) throw new Error("invalid");
  const tax = Math.floor((amount * ctx.config.taxPercent) / 100);
  const changes = [
    { userId: from, amount: -amount },
    { userId: to, amount: amount - tax },
  ];
  if (tax) changes.push({ userId: "treasury", amount: tax });
  return transact(ctx, id, changes, "pay");
}
