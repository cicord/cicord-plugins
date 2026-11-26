import type { Context } from "@cicord/sdk";
import type { Room } from "./rooms.ts";

export async function publishCreated(ctx: Context, id: string, room: Room) {
  if (room.opened !== "pending" || !ctx.features.enabled("roomEvents")) return;
  await ctx.events.publish(
    "roomCreated",
    { channelId: id, ownerId: room.owner },
    { version: 1, idempotencyKey: "create:" + id },
  );
  const e = await ctx.kv.getEntry("room:" + id);
  if (e && (e.value as unknown as Room).opened === "pending")
    await ctx.kv
      .atomic()
      .check("room:" + id, e.version)
      .set("room:" + id, { ...(e.value as Record<string, string>), opened: "sent" })
      .commit();
}

export async function publishClosed(ctx: Context, id: string, room: Room) {
  if (room.opened === "moving" || !ctx.features.enabled("roomEvents")) return;
  await publishCreated(ctx, id, room);
  const durationMinutes = Math.max(
    0,
    Math.floor((Date.now() - Date.parse(room.createdAt)) / 60000),
  );
  await ctx.events.publish(
    "roomClosed",
    { channelId: id, ownerId: room.owner, durationMinutes, peak: room.peak ?? 1 },
    { version: 1, idempotencyKey: "close:" + id },
  );
}
