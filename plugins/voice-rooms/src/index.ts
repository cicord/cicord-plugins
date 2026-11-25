import {
  command,
  definePlugin,
  subcommand,
  type CommandInteraction,
  type Context,
  type Member,
  type VoiceStateUpdate,
} from "@cicord/sdk";
import {
  BOT_PERMISSIONS,
  PERMIT_PERMISSIONS,
  deleteIfEmpty,
  deleteRoom,
  errorText,
  getRoom,
  hubChannel,
  hubOf,
  humansIn,
  isStaff,
  listRooms,
  mayUseHub,
  nextNumber,
  reason,
  roomLeft,
  roomName,
  roomSettings,
  saveRoom,
  type Hub,
  type Room,
} from "./rooms.ts";

// ───────────────────────────────────────────────────────────── join to create

// Members whose hub join is being handled: Discord may send several updates while the
// room is created (and the bot's own move sends one more).
const creating = new Set<string>();
// When each member last got a room (cooldownSeconds).
const lastCreated = new Map<string, number>();

async function hubJoined(ctx: Context, member: Member, hub: Hub, hubId: string): Promise<void> {
  if (creating.has(member.id)) return;
  creating.add(member.id);
  try {
    if (!mayUseHub(hub, member)) {
      await member.disconnect(reason("not allowed to use this hub"));
      return;
    }
    // One room per member and hub: back to it if they still own one.
    const rooms = await listRooms(ctx);
    const own = rooms.find((r) => r.room.hub === hubId && r.room.owner === member.id);
    if (own) {
      try {
        await member.moveTo({ id: own.id }, reason("back to their room"));
        return;
      } catch (e) {
        ctx.log.warn("could not move a member back to their room", {
          channel: own.id,
          error: errorText(e),
        });
        if (!(await deleteIfEmpty(ctx, own.id, "unreachable"))) return;
      }
    }
    const cooldown = ctx.config.cooldownSeconds * 1000;
    const last = lastCreated.get(member.id);
    if (cooldown > 0 && last !== undefined && Date.now() - last < cooldown) {
      await member.disconnect(
        reason("rooms are created at most every " + ctx.config.cooldownSeconds + " s"),
      );
      return;
    }
    lastCreated.set(member.id, Date.now());
    await createRoom(ctx, member, hub, hubId, nextNumber(rooms, hubId));
  } finally {
    creating.delete(member.id);
  }
}

async function createRoom(
  ctx: Context,
  member: Member,
  hub: Hub,
  hubId: string,
  n: number,
): Promise<void> {
  const categoryId = hubChannel(ctx, hub)?.categoryId;
  const category = hub.category ?? (categoryId ? { id: categoryId } : undefined);
  // Created without overwrites, a channel in a category gets the category's: a room of a
  // private category stays private. The owner's and the bot's are added next.
  const channel = await ctx.server.createChannel({
    name: roomName(hub.name, member, n),
    type: "voice",
    ...(category ? { category } : {}),
    ...(hub.userLimit > 0 ? { userLimit: hub.userLimit } : {}),
    ...(hub.bitrate !== undefined ? { bitrate: hub.bitrate } : {}),
  });
  await saveRoom(ctx, channel.id, {
    hub: hubId,
    owner: member.id,
    n,
    createdAt: new Date().toISOString(),
  });
  try {
    await ctx.server.editChannel(channel, {
      overwrites: {
        [`member:${member.id}`]: { allow: [...hub.ownerPermissions] },
        [`member:${ctx.bot.user.id}`]: { allow: [...BOT_PERMISSIONS] },
      },
      reason: reason("owner permissions"),
    });
  } catch (e) {
    // The room works without them; the bot misses a permission it would give.
    ctx.log.error("could not give the owner their permissions", {
      channel: channel.id,
      error: errorText(e),
    });
  }
  try {
    await member.moveTo(channel, reason("new room"));
  } catch (e) {
    // They left voice meanwhile: nobody will ever join this room.
    ctx.log.info("member left before being moved to their room", {
      channel: channel.id,
      error: errorText(e),
    });
    await deleteIfEmpty(ctx, channel.id, "owner left before joining");
    return;
  }
  ctx.log.info("voice room created", { channel: channel.id, owner: member.id, hub: hubId });
}

async function voiceStateUpdate(ctx: Context, u: VoiceStateUpdate): Promise<void> {
  const now = u.channel?.id;
  const before = u.previous?.id;
  if (now === before) return; // mute, deafen, stream, camera
  if (before) {
    const room = await getRoom(ctx, before);
    if (room) await roomLeft(ctx, before, room);
  }
  if (!now || u.user.bot) return;
  const hub = hubOf(ctx, now);
  if (!hub) return;
  const member = u.member ?? (await ctx.server.member(u.user.id));
  if (member) await hubJoined(ctx, member, hub, now);
}

// ───────────────────────────────────────────────────────────── /voice

type Target = { id: string; room: Room };

/**
 * The room a command acts on: the one whose chat it is typed in, else the one the member is
 * connected to, else one they own.
 */
async function targetRoom(ctx: Context, i: CommandInteraction): Promise<Target | undefined> {
  const rooms = await listRooms(ctx);
  const inChat = i.channel && rooms.find((r) => r.id === i.channel!.id);
  if (inChat) return inChat;
  for (const r of rooms) {
    try {
      if ((await ctx.server.voiceMembers({ id: r.id })).some((m) => m.id === i.user.id)) return r;
    } catch {
      break; // voice states not known yet
    }
  }
  return rooms.find((r) => r.room.owner === i.user.id);
}

/** The target room, if the member owns it or is staff; replies otherwise. */
async function managed(ctx: Context, i: CommandInteraction): Promise<Target | undefined> {
  const t = await targetRoom(ctx, i);
  if (!t) {
    await i.reply("Join your voice room first (or use this command in its chat).");
    return undefined;
  }
  if (t.room.owner !== i.user.id && !isStaff(ctx, i.member)) {
    await i.reply(
      `<#${t.id}> belongs to <@${t.room.owner}>: only they (or the staff) can change it.`,
    );
    return undefined;
  }
  return t;
}

// Discord allows two renames of a channel per 10 minutes: the third would wait for minutes.
const renames = new Map<string, number[]>();
const RENAME_WINDOW = 10 * 60 * 1000;

/** Moves ownership of a room to `to` (who must be in it). */
/**
 * Whether `member` may own the room: like using its hub, they need one of the hub's allowed
 * roles (a guest let into a guild room cannot take it over). Staff may.
 */
function mayOwn(ctx: Context, t: Target, member: Member): boolean {
  const { allowedRoles } = roomSettings(ctx, t.room);
  return (
    allowedRoles.length === 0 ||
    allowedRoles.some((role) => member.hasRole(role)) ||
    isStaff(ctx, member)
  );
}

async function setOwner(ctx: Context, t: Target, to: Member, why: string): Promise<void> {
  const { ownerPermissions } = roomSettings(ctx, t.room);
  await ctx.server.editChannel(
    { id: t.id },
    {
      overwrites: {
        [`member:${t.room.owner}`]: null,
        [`member:${to.id}`]: { allow: [...ownerPermissions] },
      },
      reason: reason(why),
    },
  );
  await saveRoom(ctx, t.id, { ...t.room, owner: to.id });
}

const memberOption = (description: string) =>
  ({ type: "user", description, required: true }) as const;

const voice = command({
  description: "Manage your voice room",
  ephemeral: true,
  subcommands: {
    rename: subcommand({
      description: "Rename your voice room",
      options: {
        name: {
          type: "string",
          description: "New name",
          required: true,
          minLength: 1,
          maxLength: 100,
        },
      },
      async run(ctx, i) {
        const t = await managed(ctx, i);
        if (!t) return;
        const recent = (renames.get(t.id) ?? []).filter((at) => Date.now() - at < RENAME_WINDOW);
        if (recent.length >= 2) {
          await i.reply("Discord allows two renames per 10 minutes: try again later.");
          return;
        }
        renames.set(t.id, [...recent, Date.now()]);
        await ctx.server.editChannel(
          { id: t.id },
          { name: i.options.name, reason: reason("renamed by " + i.user.id) },
        );
        await i.reply(`Renamed to **${i.options.name}**.`);
      },
    }),
    limit: subcommand({
      description: "Set how many members your voice room holds (0: no limit)",
      options: {
        count: { type: "integer", description: "Members (0-99)", required: true, min: 0, max: 99 },
      },
      async run(ctx, i) {
        const t = await managed(ctx, i);
        if (!t) return;
        await ctx.server.editChannel(
          { id: t.id },
          { userLimit: i.options.count, reason: reason("limit") },
        );
        await i.reply(
          i.options.count === 0 ? "No limit any more." : `Limit set to ${i.options.count}.`,
        );
      },
    }),
    lock: subcommand({
      description: "Lock your voice room: only members you permit can join",
      async run(ctx, i) {
        const t = await managed(ctx, i);
        if (!t) return;
        await setConnect(ctx, t, "deny");
        await i.reply("Locked: members you permit (`/voice permit`) can still join.");
      },
    }),
    unlock: subcommand({
      description: "Unlock your voice room",
      async run(ctx, i) {
        const t = await managed(ctx, i);
        if (!t) return;
        await setConnect(ctx, t, "clear");
        await i.reply("Unlocked.");
      },
    }),
    permit: subcommand({
      description: "Let a member join your voice room, even locked",
      options: { member: memberOption("Member to let in") },
      async run(ctx, i) {
        const t = await managed(ctx, i);
        if (!t) return;
        await ctx.server.editChannel(
          { id: t.id },
          {
            overwrites: { [`member:${i.options.member.id}`]: { allow: [...PERMIT_PERMISSIONS] } },
            reason: reason("permit"),
          },
        );
        await i.reply(`${i.options.member.mention} can join <#${t.id}>.`);
      },
    }),
    kick: subcommand({
      description: "Disconnect a member from your voice room and keep them out",
      options: { member: memberOption("Member to kick") },
      async run(ctx, i) {
        const t = await managed(ctx, i);
        if (!t) return;
        const target = i.options.member;
        if (
          target.id === i.user.id ||
          target.id === ctx.bot.user.id ||
          target.id === t.room.owner
        ) {
          await i.reply("You cannot kick yourself, the bot or the owner of the room.");
          return;
        }
        await ctx.server.editChannel(
          { id: t.id },
          {
            overwrites: { [`member:${target.id}`]: { deny: ["Connect"] } },
            reason: reason("kick"),
          },
        );
        const inRoom = (await humansIn(ctx, t.id).catch(() => [])).find((m) => m.id === target.id);
        if (inRoom) await inRoom.disconnect(reason("kicked from the room"));
        await i.reply(
          `${target.mention} is out of <#${t.id}> (\`/voice permit\` lets them back in).`,
        );
      },
    }),
    transfer: subcommand({
      description: "Give your voice room to a member who is in it",
      options: { member: memberOption("New owner") },
      async run(ctx, i) {
        const t = await managed(ctx, i);
        if (!t) return;
        const to = (await humansIn(ctx, t.id)).find((m) => m.id === i.options.member.id);
        if (!to) {
          await i.reply(`${i.options.member.mention} must be in <#${t.id}> to receive it.`);
          return;
        }
        if (!mayOwn(ctx, t, to)) {
          await i.reply(`${to.mention} cannot own <#${t.id}>: it is for the roles of its hub.`);
          return;
        }
        await setOwner(ctx, t, to, "transferred");
        await i.reply(`<#${t.id}> now belongs to ${to.mention}.`);
      },
    }),
    claim: subcommand({
      description: "Take over the voice room you are in, once its owner left",
      async run(ctx, i) {
        const t = await targetRoom(ctx, i);
        const humans = t ? await humansIn(ctx, t.id) : [];
        const me = humans.find((m) => m.id === i.user.id);
        if (!t || !me) {
          await i.reply("Join the voice room you want to claim first.");
          return;
        }
        if (t.room.owner === i.user.id) {
          await i.reply("This room is already yours.");
          return;
        }
        if (humans.some((m) => m.id === t.room.owner) && !isStaff(ctx, i.member)) {
          await i.reply(
            `<@${t.room.owner}> is still in <#${t.id}>: ask them for \`/voice transfer\`.`,
          );
          return;
        }
        if (!mayOwn(ctx, t, me)) {
          await i.reply(`You cannot own <#${t.id}>: it is for the roles of its hub.`);
          return;
        }
        await setOwner(ctx, t, me, "claimed");
        await i.reply(`<#${t.id}> is yours now.`);
      },
    }),
  },
});

/** Lock (deny Connect) or unlock (clear it) for @everyone and the hub's allowed roles. */
async function setConnect(ctx: Context, t: Target, how: "deny" | "clear"): Promise<void> {
  const { allowedRoles } = roomSettings(ctx, t.room);
  const patch = how === "deny" ? { deny: ["Connect" as const] } : { clear: ["Connect" as const] };
  const overwrites = Object.fromEntries(
    ["@everyone", ...allowedRoles].map((target) => [target, patch]),
  );
  await ctx.server.editChannel(
    { id: t.id },
    { overwrites, reason: reason(how === "deny" ? "lock" : "unlock") },
  );
}

// ───────────────────────────────────────────────────────────── plugin

/** Checks every room: deletes the empty ones (and forgets those deleted by hand). */
async function sweep(ctx: Context): Promise<void> {
  for (const { id } of await listRooms(ctx)) {
    await deleteIfEmpty(ctx, id, "empty");
  }
}

export default definePlugin({
  async onStart(ctx) {
    const rooms = await listRooms(ctx);
    if (rooms.length === 0) return;
    if (ctx.config.onRestart === "delete") {
      for (const { id } of rooms) await deleteRoom(ctx, id, "plugin restarted");
      return;
    }
    // Adopted: checked once the gateway has sent the voice states (they are not known
    // during the start that follows a connection).
    await ctx.schedule.after(15_000, "sweep");
  },

  events: { voiceStateUpdate },

  commands: { voice },

  tasks: {
    async cleanup(ctx, payload) {
      const id = (payload as { room?: string } | undefined)?.room;
      if (!id) return;
      const room = await getRoom(ctx, id);
      if (!room) return;
      const { cleanup: _, ...rest } = room;
      await saveRoom(ctx, id, rest);
      await deleteIfEmpty(ctx, id, "empty");
    },
    async sweep(ctx) {
      await sweep(ctx);
    },
  },

  schedules: {
    // Catches what events cannot: a room left while the bot was disconnected, deleted by hand…
    sweep: { cron: "*/5 * * * *", run: sweep },
  },
});
