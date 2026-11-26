import type { Context, Json, Permission, OverwritePatch } from "@cicord/sdk";
import { getRoom, hubChannel, patchRoom, pendingKey, reserveRename, roomSettings } from "./rooms.ts";
import type { Room } from "./rooms.ts";

type State = "allow" | "deny" | "clear";
type Overwrite = { allow: Permission[]; deny: Permission[] };
export type Change = { before: State; parent: State; applied: State };
export type History = Partial<Record<Permission, Change>>;
const state = (o: Overwrite | undefined, p: Permission): State =>
  o?.allow.includes(p) ? "allow" : o?.deny.includes(p) ? "deny" : "clear";

async function current(ctx: Context, id: string, userId: string) {
  const channel = ctx.server.channel({ id });
  const child = await channel.memberOverwrite(userId);
  const parent = channel.categoryId
    ? await ctx.server.channel({ id: channel.categoryId }).memberOverwrite(userId)
    : undefined;
  return { child, parent };
}
/** Record only the individual permission bits touched by this instance. */
export async function remember(
  ctx: Context,
  id: string,
  userId: string,
  patch: { allow?: Permission[]; deny?: Permission[] },
) {
  const { child, parent } = await current(ctx, id, userId);
  await patchRoom(ctx, id, (room) => {
    const changes = ((room.acl ??= {})[userId] ??= {});
    for (const side of ["allow", "deny"] as const)
      for (const perm of patch[side] ?? []) {
        const previous = changes[perm],
          before = state(child, perm);
        changes[perm] =
          previous && previous.applied === before
            ? { ...previous, applied: side }
            : { before, parent: state(parent, perm), applied: side };
      }
  });
}
export async function releasePatch(
  ctx: Context,
  id: string,
  room: Room,
  userId: string,
): Promise<OverwritePatch | null | undefined> {
  if (userId === ctx.bot.user.id) return;
  const { child, parent } = await current(ctx, id, userId);
  if (!child) return;
  const patch: OverwritePatch = {};
  let history = room.acl?.[userId];
  // Legacy ownership is attributable, but only positive bits actually granted by the hub
  // are known. Preserve staff denies and restore the present category policy for these bits.
  if (!history && room.owner === userId && (room.legacy || room.opened === undefined)) {
    history = {};
    for (const p of roomSettings(ctx, room).ownerPermissions)
      if (child.allow.includes(p))
        history[p] = { applied: "allow", before: state(parent, p), parent: state(parent, p) };
  }
  if (!history) return;
  for (const [name, h] of Object.entries(history)) {
    const perm = name as Permission;
    if (!h || state(child, perm) !== h.applied) continue;
    const restore = h.before === h.parent ? state(parent, perm) : h.before;
    if (restore !== h.applied) (patch[restore] ??= []).push(perm);
  }
  if (!Object.keys(patch).length) return;
  const remaining = new Set([...child.allow, ...child.deny]);
  for (const perm of patch.clear ?? []) remaining.delete(perm);
  for (const perm of [...(patch.allow ?? []), ...(patch.deny ?? [])]) remaining.add(perm);
  return remaining.size ? patch : null;
}
export async function revoke(ctx: Context, id: string, room: Room, userId: string) {
  if (userId === ctx.bot.user.id) return;
  const patch = await releasePatch(ctx, id, room, userId);
  if (patch !== undefined)
    await ctx.server.editChannel(
      { id },
      {
        overwrites: { ["member:" + userId]: patch },
        reason: "voice-rooms: restore prior permission bits",
      },
    );
  await patchRoom(ctx, id, (r) => {
    if (r.acl) delete r.acl[userId];
    if (r.guests) delete r.guests[userId];
  });
}
export async function memberData(ctx: Context, userId: string, erase: boolean) {
  const records: Json[] = [];
  let erased = 0,
    cursor: string | undefined;
  const cooldown = await ctx.kv.get("cooldown:" + userId);
  if (cooldown !== undefined) {
    records.push({ cooldown });
    if (erase) {
      await ctx.kv.delete("cooldown:" + userId);
      erased++;
    }
  }
  // Creation markers (two-minute TTL) name the member while a room is being created.
  for (const hub of ctx.config.hubs ?? []) {
    const id = hubChannel(ctx, hub)?.id;
    if (!id || (await ctx.kv.get(pendingKey(id, userId))) === undefined) continue;
    records.push({ creatingRoomIn: id });
    if (erase) {
      await ctx.kv.delete(pendingKey(id, userId));
      erased++;
    }
  }
  do {
    const page = await ctx.kv.list({ prefix: "room:", limit: 50, cursor });
    for (const { key } of page.items) {
      const id = key.slice(5),
        room = await getRoom(ctx, id);
      if (!room) continue;
      const owns = room.owner === userId,
        named = room.nameOwner === userId,
        access = room.guests?.[userId],
        history = room.acl?.[userId];
      if (!owns && !access && !history && !named) {
        if (room.legacy || room.opened === undefined) {
          const { child, parent } = await current(ctx, id, userId);
          if (
            child &&
            [...child.allow, ...child.deny].some((p) => state(child, p) !== state(parent, p))
          )
            records.push({
              room: id,
              legacyDiscordOverride: true,
              policy: "retain",
              reason: "No actor evidence in the 0.1 room record",
            });
        }
        continue;
      }
      records.push({
        channelId: id,
        owns,
        ...(named ? { name: room.name ?? null } : {}),
        hub: room.hub,
        createdAt: room.createdAt,
        ...(access ? { access } : {}),
        ...(history ? { permissions: history } : {}),
      });
      if (!erase) continue;
      if (owns || access || history) await revoke(ctx, id, room, userId);
      if (owns || named) {
        const channel = ctx.server.channel({ id });
        const member = await ctx.server.member(userId);
        const generated =
          member &&
          (channel.name.includes(member.displayName) ||
            channel.name.includes(member.user.username));
        if (
          (named && room.name === channel.name) ||
          (owns && (room.legacy || room.opened === undefined) && generated)
        ) {
          // Counted against the rename window, never refused.
          await reserveRename(ctx, id, true);
          await ctx.server.editChannel(channel, {
            name: ctx.i18n.t("anonymousRoom", { number: room.n }),
            reason: "voice-rooms: erase owner name",
          });
        }
        await patchRoom(ctx, id, (r) => {
          if (r.owner === userId) r.owner = ctx.bot.user.id;
          if (r.nameOwner === userId) {
            delete r.name;
            delete r.nameOwner;
          }
        });
      }
      erased++;
    }
    cursor = page.cursor;
  } while (cursor);
  return { records, erased };
}
