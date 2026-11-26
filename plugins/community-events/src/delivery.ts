import type { Context, Message } from "@cicord/sdk";

// Discord enforces a nonce for only a few minutes. A late replay of an
// ambiguous send is recorded for staff and never issues a new Discord request.
const RETRY_WINDOW = 60_000,
  LEASE = 12_000;
export const receiptTTL = 30 * 86400;
type Delivery = {
  state: "running" | "done" | "uncertain";
  first: number;
  lease: number;
  messageId?: string;
};
export async function sendOnce(
  ctx: Context,
  key: string,
  send: () => Promise<Message | undefined>,
  retractable = false,
) {
  const entry = await ctx.kv.getEntry<Delivery | boolean>(key);
  if (entry?.value === true) return; // Older versions stored true after delivery.
  const prev = typeof entry?.value === "object" ? entry.value : undefined;
  if (prev && prev.state !== "running") return;
  const now = Date.now(),
    first = prev?.first ?? now;
  if (prev && now - first >= RETRY_WINDOW) {
    const result = await ctx.kv
      .atomic()
      .check(key, entry?.version)
      .set(key, { ...prev, state: "uncertain" }, { ttlSeconds: receiptTTL })
      .commit();
    if (result.ok)
      ctx.log.warn("Event notification delivery could not be confirmed; retry window expired.");
    return;
  }
  if (prev && prev.lease > now) throw new Error("Event notification is already being delivered");
  const claimed = await ctx.kv
    .atomic()
    .check(key, entry?.version)
    .set(key, { state: "running", first, lease: now + LEASE }, { ttlSeconds: receiptTTL })
    .commit();
  if (!claimed.ok) throw new Error("Event notification receipt changed during delivery");
  const lock = await ctx.kv.getEntry<Delivery>(key);
  if (!lock || lock.value.state !== "running" || lock.value.first !== first) return;
  const message = await send();
  if (retractable && message)
    await ctx.schedule.after(receiptTTL * 1000, "retract", { messageId: message.id });
  const settled = await ctx.kv
    .atomic()
    .check(key, lock.version)
    .set(
      key,
      { state: "done", first, lease: 0, ...(message ? { messageId: message.id } : {}) },
      { ttlSeconds: receiptTTL },
    )
    .commit();
  if (!settled.ok && retractable && message) await ctx.server.retractDM(message.id);
}
