import type { Context, Json } from "@cicord/sdk";
import type { LedgerRow } from "./routes.ts";
import { offsetAt } from "./timezone.ts";

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
type Options = {
  claim?: "daily" | "weekly";
  earned?: boolean;
  cooldown?: number;
  product?: Product;
};
export const balanceKey = (uid: string) => "balance:" + uid;
export const inventoryPrefix = (uid: string) => "order:" + uid + ":";
export type Order = { userId: string; id: string; item: Product; state: "pending" | "delivered" };
/** The first row owns the idempotency receipt. The journal, balances, limits, claim and purchase all commit together. */
export async function transact(
  ctx: Context,
  id: string,
  changes: Change[],
  reason: string,
  options: Options = {},
): Promise<number> {
  if (!ctx.config.enabled) throw new Error("off");
  const uid = changes[0]!.userId;
  const rowId = (user: string) => `ledger:${user}:${id}`;
  for (;;) {
    const existing = await ctx.kv.get<LedgerRow>(rowId(uid));
    if (existing) {
      await publish(ctx, id, changes);
      return existing.balance;
    }
    const now = Date.now(),
      day = dayNumber(ctx, now);
    const checks = ctx.kv.atomic().check(rowId(uid), null);
    const delta = changes.map((e) => ({ ...e }));
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
      if (!delta[0]!.amount) return (await ctx.kv.get<number>(balanceKey(uid))) ?? 0;
      checks
        .check(ek, earn?.version ?? null)
        .set(ek, (earn?.value ?? 0) + delta[0]!.amount, { ttlSeconds: 172800 });
      if (options.cooldown) {
        const ck = "cool:" + uid,
          prev = await ctx.kv.getEntry<number>(ck);
        if (prev && now - prev.value < options.cooldown * 1000)
          return (await ctx.kv.get<number>(balanceKey(uid))) ?? 0;
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
        id,
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
    if (options.product)
      checks.set(inventoryPrefix(uid) + id, {
        id,
        userId: uid,
        item: options.product,
        state: "pending",
      } as Json);
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
      await ctx.events.publish("transaction", event, { idempotencyKey: `${id}:${userId}` });
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
