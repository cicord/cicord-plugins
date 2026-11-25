import type { Context, Json, Member, PluginConfig, TextChannel } from "@cicord/sdk";

export type Hub = PluginConfig["hubs"][number];
export type Permission = Hub["ownerPermissions"][number];

/** A room: a voice channel created from a hub, stored under `room:<channel id>`. */
export interface Room {
  /** Channel id of the hub it was created from. */
  hub: string;
  /** User id of the owner. */
  owner: string;
  /** Number among the rooms of the hub ({n}). */
  n: number;
  createdAt: string;
  /** Id of the scheduled cleanup task, while one is pending. */
  cleanup?: string;
}

const ROOM = "room:";
const roomKey = (id: string) => ROOM + id;

/** Permissions the bot keeps in its rooms: it moves members in even once they are locked. */
export const BOT_PERMISSIONS = ["ViewChannel", "Connect", "MoveMembers"] as const;
/** What /voice permit grants. */
export const PERMIT_PERMISSIONS = ["ViewChannel", "Connect"] as const;
const DEFAULT_OWNER_PERMISSIONS: Permission[] = [
  "ViewChannel",
  "Connect",
  "Speak",
  "Stream",
  "MoveMembers",
];

/** Audit log reasons. */
export const reason = (what: string) => `voice-rooms: ${what}`;

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ───────────────────────────────────────────────────────────── state

export async function getRoom(ctx: Context, id: string): Promise<Room | undefined> {
  return (await ctx.kv.get(roomKey(id))) as Room | undefined;
}

export async function saveRoom(ctx: Context, id: string, room: Room): Promise<void> {
  await ctx.kv.set(roomKey(id), room as unknown as Json);
}

async function forgetRoom(ctx: Context, id: string): Promise<void> {
  await ctx.kv.delete(roomKey(id));
}

/** Every room, by channel id. */
export async function listRooms(ctx: Context): Promise<{ id: string; room: Room }[]> {
  const out: { id: string; room: Room }[] = [];
  let cursor: string | undefined;
  do {
    const page = await ctx.kv.list({
      prefix: ROOM,
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    for (const item of page.items)
      out.push({ id: item.key.slice(ROOM.length), room: item.value as unknown as Room });
    cursor = page.cursor;
  } while (cursor);
  return out;
}

// ───────────────────────────────────────────────────────────── hubs

/** The hub whose channel is `channelId`. Hubs whose channel does not exist are skipped. */
export function hubOf(ctx: Context, channelId: string): Hub | undefined {
  for (const hub of ctx.config.hubs) {
    if (hubChannel(ctx, hub)?.id === channelId) return hub;
  }
  return undefined;
}

export function hubChannel(ctx: Context, hub: Hub): TextChannel | undefined {
  try {
    return ctx.server.channel(hub.channel);
  } catch {
    return undefined;
  }
}

/** The owner permissions and allowed roles of a room's hub (defaults when the hub is gone). */
export function roomSettings(
  ctx: Context,
  room: Room,
): { ownerPermissions: Permission[]; allowedRoles: string[] } {
  const hub = hubOf(ctx, room.hub);
  return {
    ownerPermissions: hub?.ownerPermissions ?? DEFAULT_OWNER_PERMISSIONS,
    allowedRoles: hub?.allowedRoles ?? [],
  };
}

/** Whether the member may use the hub (allowedRoles). */
export function mayUseHub(hub: Hub, member: Member): boolean {
  return hub.allowedRoles.length === 0 || hub.allowedRoles.some((role) => member.hasRole(role));
}

/** The room name: the hub's template with {member}, {username} and {n}, at most 100 characters. */
export function roomName(template: string, member: Member, n: number): string {
  const name = template
    .replaceAll("{member}", member.displayName)
    .replaceAll("{username}", member.user.username)
    .replaceAll("{n}", String(n))
    .trim();
  // Discord counts code points (an emoji is one character).
  const chars = Array.from(name);
  return (chars.length > 100 ? chars.slice(0, 100).join("") : name) || `room ${n}`;
}

/** The lowest number not used by another room of the hub. */
export function nextNumber(rooms: { room: Room }[], hubId: string): number {
  const used = new Set(rooms.filter((r) => r.room.hub === hubId).map((r) => r.room.n));
  let n = 1;
  while (used.has(n)) n++;
  return n;
}

// ───────────────────────────────────────────────────────────── access

/** A staff role, a Cicord moderator or admin, or the server owner. Unknown access never counts. */
export function isStaff(ctx: Context, member: Member | undefined): boolean {
  if (!member) return false;
  if (member.access === "admin" || member.access === "moderator") return true;
  if (ctx.server.ownerId !== undefined && member.id === ctx.server.ownerId) return true;
  return ctx.config.staffRoles.some((role) => member.hasRole(role));
}

// ───────────────────────────────────────────────────────────── cleanup

// Rooms being deleted by this instance: two members leaving at once delete it once.
const deleting = new Set<string>();

/** Humans in a room (bots, a music bot for instance, do not keep it alive). */
export async function humansIn(ctx: Context, id: string): Promise<Member[]> {
  return (await ctx.server.voiceMembers({ id })).filter((m) => !m.user.bot);
}

/**
 * Deletes the room when nobody (but bots) is in it, and forgets it. Returns false when it
 * was kept or could not be checked: the voice states are not known yet (just after a
 * start), the periodic check tries again.
 */
export async function deleteIfEmpty(ctx: Context, id: string, why: string): Promise<boolean> {
  if (deleting.has(id)) return false;
  let humans: Member[];
  try {
    humans = await humansIn(ctx, id);
  } catch (e) {
    ctx.log.warn("could not check a voice room", { channel: id, error: errorText(e) });
    return false;
  }
  if (humans.length > 0) return false;
  return deleteRoom(ctx, id, why);
}

/** Deletes a room (whoever is in it is disconnected) and forgets it. */
export async function deleteRoom(ctx: Context, id: string, why: string): Promise<boolean> {
  if (deleting.has(id)) return false;
  deleting.add(id);
  try {
    const room = await getRoom(ctx, id);
    try {
      // A channel deleted by hand is gone already: the host treats that as done.
      await ctx.server.deleteChannel({ id }, reason(why));
    } catch (e) {
      // Not owned (any more): the ownership record is gone, only the KV entry is left.
      if (!errorText(e).includes("not owned")) {
        ctx.log.error("could not delete a voice room", { channel: id, error: errorText(e) });
        return false;
      }
    }
    await forgetRoom(ctx, id);
    if (room?.cleanup) await ctx.schedule.cancel(room.cleanup).catch(() => undefined);
    ctx.log.info("voice room deleted", { channel: id, why });
    return true;
  } finally {
    deleting.delete(id);
  }
}

/**
 * A member left a room: deletes it now when it is empty, or after the grace delay
 * (emptyDelaySeconds) when the cleanup task finds it still empty.
 */
export async function roomLeft(ctx: Context, id: string, room: Room): Promise<void> {
  const delay = ctx.config.emptyDelaySeconds;
  if (delay === 0) {
    await deleteIfEmpty(ctx, id, "empty");
    return;
  }
  if (room.cleanup) return; // already pending
  let humans: Member[];
  try {
    humans = await humansIn(ctx, id);
  } catch (e) {
    ctx.log.warn("could not check a voice room", { channel: id, error: errorText(e) });
    return;
  }
  if (humans.length > 0) return;
  const task = await ctx.schedule.after(delay * 1000, "cleanup", { room: id });
  await saveRoom(ctx, id, { ...room, cleanup: task.id });
}
