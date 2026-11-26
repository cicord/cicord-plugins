import type { History } from "./privacy.ts";
import { publishClosed } from "./lifecycle.ts";
import type { ChannelRef, Context, Json, Member, PluginConfig, TextChannel } from "@cicord/sdk";

export type Hub = NonNullable<PluginConfig["hubs"]>[number];
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
  cleanupDue?: number;
  cleanupToken?: string;
  opened?: "moving" | "pending" | "sent";
  peak?: number;
  name?: string;
  nameOwner?: string;
  acl?: Record<string, History>;
  guests?: Record<string, "permit" | "kick">;
  /** Adopted 0.1 rooms may have unrecorded per-member overwrites. */
  legacy?: boolean;
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

/** Saves a room. `pending`: the creation marker to clear in the same commit. */
export async function saveRoom(
  ctx: Context,
  id: string,
  room: Room,
  pending?: string,
): Promise<void> {
  if (!pending) return ctx.kv.set(roomKey(id), room as unknown as Json);
  await ctx.kv
    .atomic()
    .set(roomKey(id), room as unknown as Json)
    .delete(pending)
    .commit();
}

// ───────────────────────────────────────────────────────────── creation and permissions

/**
 * Creation marker of a member's room in a hub, claimed (check-null) before `createChannel`
 * and cleared with the room record. It holds the token of the attempt's `provisionKey`: a
 * redelivered or interrupted hub join resumes with the same key, so the host returns the
 * channel the first attempt created instead of a second one. The sweep finishes or cleans
 * up markers left by a crash (an untracked channel is deleted once empty).
 */
export const PENDING = "pending:";
export const pendingKey = (hubId: string, memberId: string) => PENDING + hubId + ":" + memberId;
export type Pending = { token: string; at: number };
export const PENDING_SECONDS = 86400;
/** A marker older than this belongs to an interrupted attempt (the sweep cleans it up). */
export const STALE_PENDING_MS = 120_000;
export const provisionKey = (hubId: string, memberId: string, token: string) =>
  "room:" + hubId + ":" + memberId + ":" + token;
/** A hub whose rooms Discord refused for a missing permission: joins wait BLOCKED_SECONDS. */
export const blockedKey = (hubId: string) => "blocked:" + hubId;
export const BLOCKED_SECONDS = 300;
/** Instance status line of a hub missing Discord permissions. */
export const permissionsStatus = (hubId: string) => "permissions:" + hubId;

/** Discord refused the request for a missing permission (not a missing Cicord grant). */
export function permissionRefusal(e: unknown): boolean {
  return /discord: missing permissions|missing permissions|HTTP 403|50013/i.test(errorText(e));
}

/**
 * The Discord permissions the bot lacks to run the hub: Move Members in the hub, and
 * Manage Channels, Connect and Move Members where its rooms are created. Unknown
 * permissions (an empty answer: the bot member is not known yet) never block.
 */
export async function missingPermissions(
  ctx: Context,
  hub: Hub,
  target: ChannelRef | undefined,
): Promise<Permission[]> {
  let bot: Member | undefined;
  try {
    bot = await ctx.server.member(ctx.bot.user.id);
  } catch {
    return [];
  }
  if (!bot) return [];
  const missing = new Set<Permission>();
  const check = (perms: readonly string[], needed: readonly Permission[]) => {
    if (!perms.length || perms.includes("Administrator")) return;
    for (const p of needed) if (!perms.includes(p)) missing.add(p);
  };
  const hubRef = hubChannel(ctx, hub);
  if (hubRef) check(bot.permissionsIn(hubRef), ["MoveMembers"]);
  check(target ? bot.permissionsIn(target) : (bot.permissions ?? []), [
    "ManageChannels",
    "Connect",
    "MoveMembers",
  ]);
  return [...missing];
}

async function forgetRoom(ctx: Context, id: string): Promise<void> {
  await ctx.kv.delete(roomKey(id));
}

/** Every room, by channel id. */
export async function listRooms(ctx: Context): Promise<{ id: string; room: Room }[]> {
  // Discord caps guilds at 500 channels. The background sweep pages stale rows separately.
  const page = await ctx.kv.list({ prefix: ROOM, limit: 500 });
  return page.items.map((item) => ({
    id: item.key.slice(ROOM.length),
    room: item.value as unknown as Room,
  }));
}

// ───────────────────────────────────────────────────────────── hubs

/** The hub whose channel is `channelId`. Hubs whose channel does not exist are skipped. */
export function hubOf(ctx: Context, channelId: string): Hub | undefined {
  for (const hub of ctx.config.hubs ?? []) {
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
    if (!room) return false;
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
    if (room) await publishClosed(ctx, id, room);
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
  const due = Date.now() + delay * 1000,
    token = crypto.randomUUID();
  const task = await ctx.schedule.after(delay * 1000, "cleanup", { room: id, due, token });
  await patchRoom(ctx, id, (current) => {
    current.cleanup = task.id;
    current.cleanupDue = due;
    current.cleanupToken = token;
  });
}

export async function patchRoom(ctx: Context, id: string, update: (room: Room) => void) {
  const key = roomKey(id);
  for (let i = 0; i < 12; i++) {
    const e = await ctx.kv.getEntry(key);
    if (!e) return;
    const room = e.value as unknown as Room;
    update(room);
    if (
      (
        await ctx.kv
          .atomic()
          .check(key, e.version)
          .set(key, room as unknown as Json)
          .commit()
      ).ok
    )
      return room;
  }
  throw Error("Concurrent room updates");
}

// Discord allows two renames of a channel per 10 minutes: the third would wait for minutes.
const RENAME_WINDOW = 10 * 60 * 1000;
/**
 * Reserves a rename of `channelId` in the durable per-channel window (shared by every realm
 * and kept across restarts). Returns false when two renames already happened within ten
 * minutes. `force` records the rename even then: privacy erasure must not be refused.
 */
export async function reserveRename(
  ctx: Context,
  channelId: string,
  force = false,
): Promise<boolean> {
  const key = "rename:" + channelId;
  for (let attempt = 0; attempt < 8; attempt++) {
    const entry = await ctx.kv.getEntry<number[]>(key),
      now = Date.now(),
      recent = (entry?.value ?? []).filter((at) => now - at < RENAME_WINDOW);
    if (recent.length >= 2 && !force) return false;
    const committed = await ctx.kv
      .atomic()
      .check(key, entry?.version ?? null)
      .set(key, [...recent, now], { ttlSeconds: RENAME_WINDOW / 1000 })
      .commit();
    if (committed.ok) return true;
  }
  throw new Error("Concurrent renames of this room; retry");
}
