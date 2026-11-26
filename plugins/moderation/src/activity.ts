import type { Context, Json } from "@cicord/sdk";
import { hideErasedActivity } from "./quarantine.ts";
import { withModerationLock } from "./moderation.ts";

// Only the Discord reference and the member owning the copy are kept here. The
// original audit text stays in Discord. The opaque cleanup job survives erasure.
type Receipt = {
  number: number;
  subject: string;
  channel: string;
  createdAt: number;
  task: string;
  message?: string;
};
const key = (number: number) => "activity-copy:" + number;
const prefix = (subject: string) => "activity-owner:" + subject + ":";
const marker = (task: string) => "Member log " + task.slice(0, 25);
const retention = 365 * 86400000;

export async function writeActivity(
  ctx: Context,
  subject: string,
  text: string,
  color = "#95a5a6",
) {
  await withModerationLock(ctx, "activity-log-lock:" + subject, async () => {
    if (await hideErasedActivity(ctx, subject)) return;
    const number = await ctx.kv.increment("activity-copy-seq");
    const channel = ctx.server.channel(ctx.config.logChannel);
    const task = await ctx.schedule.after(retention, "expireActivity", { number });
    const receipt: Receipt = {
      number,
      subject,
      channel: channel.id,
      createdAt: Date.now(),
      task: task.id,
    };
    await ctx.kv
      .atomic()
      .set(key(number), receipt)
      .set(prefix(subject) + number, number)
      .commit();
    const message = await channel.send({
      embeds: [
        {
          description: text,
          color,
          timestamp: new Date().toISOString(),
          footer: { text: marker(task.id) },
        },
      ],
      nonce: task.id.slice(0, 25),
      enforceNonce: true,
      allowedMentions: { users: false, roles: false, everyone: false },
    });
    receipt.message = message.id;
    await ctx.kv.set(key(number), receipt);
  });
}

async function withdraw(ctx: Context, receipt: Receipt) {
  const channel = ctx.server.channel({ id: receipt.channel });
  let message = receipt.message ? await channel.message(receipt.message) : undefined;
  if (!receipt.message) {
    const rows = await channel.messages({ limit: 100 });
    message = rows.find(
      (m) =>
        m.author.id === ctx.bot.user.id &&
        m.embeds.some((e) => e.footer?.text === marker(receipt.task)),
    );
    if (
      !message &&
      rows.length === 100 &&
      rows.every((m) => m.createdAt.getTime() >= receipt.createdAt)
    )
      throw new Error(
        "The staff log moved past an unacknowledged member notice; review the channel before retrying erasure.",
      );
  }
  if (message) {
    if (message.author.id !== ctx.bot.user.id)
      throw new Error("Member log author could not be verified.");
    await message.delete("Moderation record retention");
  }
  await ctx.kv
    .atomic()
    .delete(key(receipt.number))
    .delete(prefix(receipt.subject) + receipt.number)
    .commit();
}

export async function eraseActivity(ctx: Context, user: string) {
  return withModerationLock(ctx, "activity-log-lock:" + user, async () => {
    let count = 0,
      cursor: string | undefined;
    do {
      const p = await ctx.kv.list<number>({ prefix: prefix(user), limit: 50, cursor });
      for (const row of p.items) {
        const receipt = await ctx.kv.get<Receipt>(key(row.value));
        if (receipt?.subject === user) {
          await withdraw(ctx, receipt);
          await ctx.schedule.cancel(receipt.task);
          count++;
        }
      }
      cursor = p.cursor;
    } while (cursor);
    return count;
  });
}

export async function expireActivity(ctx: Context, p: Json | undefined) {
  const number = (p as { number?: number } | undefined)?.number;
  if (!number || !Number.isSafeInteger(number)) throw new Error("Invalid activity copy job.");
  const initial = await ctx.kv.get<Receipt>(key(number));
  if (!initial) return;
  await withModerationLock(ctx, "activity-log-lock:" + initial.subject, async () => {
    const current = await ctx.kv.get<Receipt>(key(number));
    if (current) await withdraw(ctx, current);
  });
}
