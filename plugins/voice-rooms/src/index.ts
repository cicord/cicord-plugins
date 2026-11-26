import { publishCreated } from "./lifecycle.ts";
import { memberData, remember, releasePatch } from "./privacy.ts";
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
  BLOCKED_SECONDS,
  BOT_PERMISSIONS,
  PENDING,
  PENDING_SECONDS,
  PERMIT_PERMISSIONS,
  STALE_PENDING_MS,
  blockedKey,
  missingPermissions,
  pendingKey,
  provisionKey,
  permissionRefusal,
  permissionsStatus,
  patchRoom,
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
  reserveRename,
  roomLeft,
  roomName,
  roomSettings,
  saveRoom,
  type Hub,
  type Pending,
  type Room,
} from "./rooms.ts";

// ───────────────────────────────────────────────────────────── join to create

// Members whose hub join is being handled: Discord may send several updates while the
// room is created (and the bot's own move sends one more).
const creating = new Set<string>();

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
    const last = cooldown > 0 ? await ctx.kv.get<number>("cooldown:" + member.id) : undefined;
    if (cooldown > 0 && last !== undefined && Date.now() - last < cooldown) {
      await member.disconnect(
        reason("rooms are created at most every " + ctx.config.cooldownSeconds + " s"),
      );
      return;
    }
    if (cooldown > 0)
      await ctx.kv.set("cooldown:" + member.id, Date.now(), {
        ttlSeconds: ctx.config.cooldownSeconds,
      });
    await createRoom(ctx, member, hub, hubId, nextNumber(rooms, hubId));
  } finally {
    creating.delete(member.id);
  }
}

/** Records a Discord permission refusal: a status line, and joins wait instead of churning. */
async function refused(ctx: Context, hub: Hub, hubId: string, what: string, error: unknown) {
  ctx.status.set(
    permissionsStatus(hubId),
    `Hub ${hub.channel}: Discord refused to ${what} (${errorText(error)}). Give the bot Manage Channels, Connect and Move Members on the hub and its room category. Joins wait ${BLOCKED_SECONDS / 60} minutes between attempts.`,
  );
  await ctx.kv.set(blockedKey(hubId), Date.now(), { ttlSeconds: BLOCKED_SECONDS });
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
  // A hub whose bot lacks Discord permissions creates nothing: no channel created then
  // deleted on every join, one status line instead.
  const missing = await missingPermissions(ctx, hub, category);
  if (missing.length) {
    ctx.status.set(
      permissionsStatus(hubId),
      `Hub ${hub.channel}: the bot lacks ${missing.join(", ")} on the hub or its room category. Joins do not create rooms until it has them.`,
    );
    return;
  }
  if (await ctx.kv.get(blockedKey(hubId))) return;
  // At-least-once: a redelivered join, or one handled by another realm, finds the marker
  // and resumes with its provisioning key, so the host returns the same channel.
  const pending = pendingKey(hubId, member.id);
  const fresh: Pending = { token: crypto.randomUUID(), at: Date.now() };
  const claimed = await ctx.kv
    .atomic()
    .check(pending, null)
    .set(pending, fresh, { ttlSeconds: PENDING_SECONDS })
    .commit();
  const marker = claimed.ok ? fresh : await ctx.kv.get<Pending>(pending);
  if (!marker) return; // cleared meanwhile: the other attempt finished
  if (!claimed.ok)
    ctx.log.info("resuming an interrupted or concurrent room creation", {
      hub: hubId,
      member: member.id,
    });
  // Created without overwrites, a channel in a category gets the category's: a room of a
  // private category stays private. The owner's and the bot's are added next.
  let channel: Awaited<ReturnType<Context["server"]["createChannel"]>>;
  try {
    channel = await ctx.server.createChannel({
      name: roomName(
        hub.name === "🔊 {member}'s channel"
          ? ctx.i18n.t("defaultName", { member: "{member}" })
          : hub.name,
        member,
        n,
      ),
      type: "voice",
      ...(category ? { category } : {}),
      ...(hub.userLimit > 0 ? { userLimit: hub.userLimit } : {}),
      ...(hub.bitrate !== undefined ? { bitrate: hub.bitrate } : {}),
      provisionKey: provisionKey(hubId, member.id, marker.token),
    });
  } catch (e) {
    // Only a refusal proves nothing was created. After an ambiguous failure the marker
    // stays: a replay resumes with the same key and never creates a second room.
    if (!permissionRefusal(e)) throw e;
    await ctx.kv.delete(pending);
    await refused(ctx, hub, hubId, "create the room", e);
    return;
  }
  if (await getRoom(ctx, channel.id)) {
    // A concurrent attempt with the same key already recorded the room and moves the member.
    await ctx.kv.delete(pending);
    return;
  }
  await saveRoom(
    ctx,
    channel.id,
    {
      opened: "moving",
      peak: 1,
      guests: {},
      ...(/\{member\}|\{username\}/.test(hub.name)
        ? { name: channel.name, nameOwner: member.id }
        : {}),
      hub: hubId,
      owner: member.id,
      n,
      createdAt: new Date().toISOString(),
    },
    pending,
  );
  try {
    await remember(ctx, channel.id, member.id, { allow: [...hub.ownerPermissions] });
    await ctx.server.editChannel(channel, {
      overwrites: {
        [`member:${member.id}`]: { allow: [...hub.ownerPermissions] },
        [`member:${ctx.bot.user.id}`]: { allow: [...BOT_PERMISSIONS] },
      },
      reason: reason("owner permissions"),
    });
    ctx.status.set("owner-permissions", null);
  } catch (e) {
    // The room works without them; the bot misses a permission it would give.
    ctx.log.error("could not give the owner their permissions", {
      channel: channel.id,
      error: errorText(e),
    });
    if (permissionRefusal(e))
      ctx.status.set(
        "owner-permissions",
        `Room owners do not get their permissions: Discord refused the overwrites (${errorText(e)}). The bot needs Manage Permissions and every owner permission on the room category.`,
      );
  }
  try {
    await member.moveTo(channel, reason("new room"));
  } catch (e) {
    if (permissionRefusal(e)) {
      await refused(ctx, hub, hubId, "move the member into their room", e);
      await deleteIfEmpty(ctx, channel.id, "the bot cannot move members");
      return;
    }
    // They left voice meanwhile: nobody will ever join this room.
    ctx.log.info("member left before being moved to their room", {
      channel: channel.id,
      error: errorText(e),
    });
    await deleteIfEmpty(ctx, channel.id, "owner left before joining");
    return;
  }
  ctx.status.set(permissionsStatus(hubId), null);
  const room = await patchRoom(ctx, channel.id, (r) => {
    r.opened = ctx.features.enabled("roomEvents") ? "pending" : "sent";
  });
  if (room) await publishCreated(ctx, channel.id, room);
  ctx.log.info("voice room created", { channel: channel.id, owner: member.id, hub: hubId });
}

async function voiceStateUpdate(ctx: Context, u: VoiceStateUpdate): Promise<void> {
  if (ctx.config.enabled === false) return;
  const now = u.channel?.id;
  const before = u.previous?.id;
  if (now === before) return; // mute, deafen, stream, camera
  if (before) {
    const room = await getRoom(ctx, before);
    if (room) await roomLeft(ctx, before, room);
  }
  if (!now || u.user.bot) return;
  const hub = hubOf(ctx, now);
  if (!hub) {
    const room = await getRoom(ctx, now);
    if (room) {
      if (room.cleanup) {
        await ctx.schedule.cancel(room.cleanup);
        await patchRoom(ctx, now, (r) => {
          delete r.cleanup;
          delete r.cleanupDue;
          delete r.cleanupToken;
        });
      }
      const peak = (await humansIn(ctx, now)).length;
      if (peak > (room.peak ?? 1))
        await patchRoom(ctx, now, (r) => {
          r.peak = Math.max(r.peak ?? 1, peak);
        });
    }
    return;
  }
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
  if (ctx.config.enabled === false) return;
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
    await i.reply(ctx.i18n.t("join"));
    return undefined;
  }
  if (t.room.owner !== i.user.id && !isStaff(ctx, i.member)) {
    await i.reply(ctx.i18n.t("ownerOnly", { room: `<#${t.id}>`, owner: `<@${t.room.owner}>` }));
    return undefined;
  }
  return t;
}

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
  if (to.id === t.room.owner) return;
  const old = await releasePatch(ctx, t.id, t.room, t.room.owner);
  await remember(ctx, t.id, to.id, { allow: [...ownerPermissions] });
  await ctx.server.editChannel(
    { id: t.id },
    {
      overwrites: {
        [`member:${to.id}`]: { allow: [...ownerPermissions] },
        ...(old === undefined ? {} : { [`member:${t.room.owner}`]: old }),
      },
      reason: reason(why),
    },
  );
  await patchRoom(ctx, t.id, (r) => {
    r.owner = to.id;
    if (r.acl) delete r.acl[t.room.owner];
    if (r.guests) {
      delete r.guests[to.id];
      delete r.guests[t.room.owner];
    }
  });
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
        if (!(await reserveRename(ctx, t.id))) {
          await i.reply(ctx.i18n.t("rate"));
          return;
        }
        await ctx.server.editChannel(
          { id: t.id },
          { name: i.options.name, reason: reason("renamed by " + i.user.id) },
        );
        await patchRoom(ctx, t.id, (r) => {
          r.name = i.options.name;
          r.nameOwner = i.user.id;
        });
        await i.reply(ctx.i18n.t("renamed", { name: i.options.name }));
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
          i.options.count === 0
            ? ctx.i18n.t("unlimited")
            : ctx.i18n.t("limit", { count: i.options.count }),
        );
      },
    }),
    lock: subcommand({
      description: "Lock your voice room: only members you permit can join",
      async run(ctx, i) {
        const t = await managed(ctx, i);
        if (!t) return;
        await setConnect(ctx, t, "deny");
        await i.reply(ctx.i18n.t("locked"));
      },
    }),
    unlock: subcommand({
      description: "Unlock your voice room",
      async run(ctx, i) {
        const t = await managed(ctx, i);
        if (!t) return;
        await setConnect(ctx, t, "clear");
        await i.reply(ctx.i18n.t("unlocked"));
      },
    }),
    permit: subcommand({
      description: "Let a member join your voice room, even locked",
      options: { member: memberOption("Member to let in") },
      async run(ctx, i) {
        const t = await managed(ctx, i);
        if (!t) return;
        await remember(ctx, t.id, i.options.member.id, { allow: [...PERMIT_PERMISSIONS] });
        await patchRoom(ctx, t.id, (r) => {
          (r.guests ??= {})[i.options.member.id] = "permit";
        });
        await ctx.server.editChannel(
          { id: t.id },
          {
            overwrites: { [`member:${i.options.member.id}`]: { allow: [...PERMIT_PERMISSIONS] } },
            reason: reason("permit"),
          },
        );
        await i.reply(
          ctx.i18n.t("permitted", { member: i.options.member.mention, room: `<#${t.id}>` }),
        );
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
          await i.reply(ctx.i18n.t("protected"));
          return;
        }
        await remember(ctx, t.id, target.id, { deny: ["Connect"] });
        await patchRoom(ctx, t.id, (r) => {
          (r.guests ??= {})[target.id] = "kick";
        });
        await ctx.server.editChannel(
          { id: t.id },
          {
            overwrites: { [`member:${target.id}`]: { deny: ["Connect"] } },
            reason: reason("kick"),
          },
        );
        const inRoom = (await humansIn(ctx, t.id).catch(() => [])).find((m) => m.id === target.id);
        if (inRoom) await inRoom.disconnect(reason("kicked from the room"));
        await i.reply(ctx.i18n.t("kicked", { member: target.mention, room: `<#${t.id}>` }));
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
          await i.reply(
            ctx.i18n.t("mustJoin", { member: i.options.member.mention, room: `<#${t.id}>` }),
          );
          return;
        }
        if (!mayOwn(ctx, t, to)) {
          await i.reply(ctx.i18n.t("wrongRole", { member: to.mention, room: `<#${t.id}>` }));
          return;
        }
        await setOwner(ctx, t, to, "transferred");
        await i.reply(ctx.i18n.t("transferred", { member: to.mention, room: `<#${t.id}>` }));
      },
    }),
    claim: subcommand({
      description: "Take over the voice room you are in, once its owner left",
      async run(ctx, i) {
        const t = await targetRoom(ctx, i);
        const humans = t ? await humansIn(ctx, t.id) : [];
        const me = humans.find((m) => m.id === i.user.id);
        if (!t || !me) {
          await i.reply(ctx.i18n.t("claimJoin"));
          return;
        }
        if (t.room.owner === i.user.id) {
          await i.reply(ctx.i18n.t("already"));
          return;
        }
        if (humans.some((m) => m.id === t.room.owner) && !isStaff(ctx, i.member)) {
          await i.reply(ctx.i18n.t("present", { owner: `<@${t.room.owner}>`, room: `<#${t.id}>` }));
          return;
        }
        if (!mayOwn(ctx, t, me)) {
          await i.reply(ctx.i18n.t("cannotClaim", { room: `<#${t.id}>` }));
          return;
        }
        await setOwner(ctx, t, me, "claimed");
        await i.reply(ctx.i18n.t("claimed", { room: `<#${t.id}>` }));
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
  if (ctx.config.enabled === false) return;
  await sweepPending(ctx);
  await sweepPage(ctx, undefined, false);
}
/**
 * Creation markers left by an interrupted attempt: the channel its provisioning key created,
 * if any, was never recorded as a room. It is deleted once empty (a member who rejoins the
 * hub meanwhile resumes it instead), then the marker is forgotten. One bounded page per run.
 */
async function sweepPending(ctx: Context) {
  const page = await ctx.kv.list<Pending>({ prefix: PENDING, limit: 25 });
  for (const { key, value } of page.items) {
    if (!value?.token || Date.now() - value.at < STALE_PENDING_MS) continue;
    const [hubId, memberId] = key.slice(PENDING.length).split(":");
    if (!hubId || !memberId) continue;
    const found = await ctx.server.recoverOwnedChannel({
      provisionKey: provisionKey(hubId, memberId, value.token),
    });
    if (found.status === "owned" && found.id && !(await getRoom(ctx, found.id))) {
      let humans: Member[];
      try {
        humans = await humansIn(ctx, found.id);
      } catch {
        continue; // voice states not known yet: next run
      }
      if (humans.length) continue;
      try {
        await ctx.server.deleteChannel({ id: found.id }, reason("interrupted room creation"));
      } catch (e) {
        ctx.log.warn("could not delete an untracked room", {
          channel: found.id,
          error: errorText(e),
        });
        continue;
      }
      ctx.log.info("deleted the channel of an interrupted room creation", { channel: found.id });
    }
    // Forget the marker unless a resumed attempt replaced it meanwhile.
    const entry = await ctx.kv.getEntry<Pending>(key);
    if (entry?.value.token === value.token)
      await ctx.kv.atomic().check(key, entry.version).delete(key).commit();
  }
}
async function sweepPage(ctx: Context, cursor: string | undefined, reset: boolean) {
  const page = await ctx.kv.list({ prefix: "room:", limit: 25, cursor });
  for (const item of page.items) {
    const id = item.key.slice(5),
      room = item.value as unknown as Room;
    if (room.opened === undefined && !room.legacy)
      await patchRoom(ctx, id, (r) => {
        r.legacy = true;
        r.peak ??= 1;
      });
    if (reset) {
      await deleteRoom(ctx, id, "plugin restarted");
      continue;
    }
    await publishCreated(ctx, id, room);
    if (!room.cleanupDue || room.cleanupDue <= Date.now()) await deleteIfEmpty(ctx, id, "empty");
  }
  if (page.cursor) await ctx.schedule.after(100, "sweep", { cursor: page.cursor, reset });
  else await ctx.kv.set("meta:schema", 2);
}

export default definePlugin({
  async onStart(ctx) {
    if (ctx.config.enabled === false) return;
    if (ctx.config.onRestart === "delete") {
      await sweepPage(ctx, undefined, true);
      return;
    }
    if ((await ctx.kv.list({ prefix: "room:", limit: 1 })).items.length)
      await ctx.schedule.after(15_000, "sweep");
    else await ctx.kv.set("meta:schema", 2);
  },
  privacy: {
    async export(ctx, id) {
      return (await memberData(ctx, id, false)).records;
    },
    async erase(ctx, id) {
      return { erased: (await memberData(ctx, id, true)).erased };
    },
  },
  events: { voiceStateUpdate },

  commands: { voice },

  tasks: {
    async cleanup(ctx, payload) {
      const id = (payload as { room?: string } | undefined)?.room;
      if (!id) return;
      const room = await getRoom(ctx, id);
      if (!room) return;
      const due = (payload as { due?: number }).due;
      if (
        due !== undefined &&
        (due !== room.cleanupDue ||
          (payload as { token?: string }).token !== room.cleanupToken ||
          Date.now() < due)
      )
        return;
      if (!room.cleanup || (due === undefined && room.cleanupDue !== undefined)) return;
      await patchRoom(ctx, id, (r) => {
        delete r.cleanup;
        delete r.cleanupDue;
        delete r.cleanupToken;
      });
      await deleteIfEmpty(ctx, id, "empty");
    },
    async sweep(ctx, payload) {
      if (ctx.config.enabled === false) return;
      const p = payload as { cursor?: string; reset?: boolean } | undefined;
      await sweepPage(ctx, p?.cursor, p?.reset === true);
    },
  },

  schedules: {
    // Catches what events cannot: a room left while the bot was disconnected, deleted by hand…
    sweep: { cron: "*/5 * * * *", run: sweep },
  },
});
