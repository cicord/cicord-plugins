import type { ReplyInput, VoiceStateUpdate } from "@cicord/sdk";
import { createTestContext, runCommand, type TestHarness } from "@cicord/sdk/testing";
import { describe, expect, test, vi } from "vite-plus/test";
import schema from "../config.schema.json" with { type: "json" };
import en from "../locales/en.json" with { type: "json" };
import fr from "../locales/fr.json" with { type: "json" };
import plugin from "../src/index.ts";

const grants = [
  "discord.channels.read",
  "discord.channels.manage",
  "discord.voice.move",
  "discord.members.read",
  "storage.kv",
  "scheduler",
];

// 1 alice, 2 bob, 3 carl (guild member): members. 4 sam: staff role. 9 olga: server owner.
// 50 a music bot.
function setup(config: Record<string, unknown> = {}) {
  const t = createTestContext({
    schema,
    locales: { en, fr },
    config: {
      hubs: [
        { channel: "create" },
        {
          channel: "create-guild",
          name: "Guild #{n}",
          category: "guilds",
          userLimit: 5,
          allowedRoles: ["guild"],
        },
      ],
      staffRoles: ["staff"],
      // The plugin module is shared by the tests: the cooldown test turns it on.
      cooldownSeconds: 0,
      ...config,
    },
    grants,
    intents: ["ServerVoiceStates"],
    plugin: { name: "voice-rooms" },
    server: { id: "100", ownerId: "9" },
    roles: { guild: { name: "Guild" }, staff: { name: "Staff" } },
    channels: {
      voice: { name: "VOCAUX", type: "category", id: "300" },
      guilds: { name: "GUILDES", type: "category", id: "301" },
      create: { name: "➕ Créer un salon", type: "voice", id: "500", categoryId: "300" },
      "create-guild": {
        name: "➕ Créer un salon guilde",
        type: "voice",
        id: "501",
        categoryId: "300",
      },
      afk: { name: "AFK", type: "voice", id: "502" },
      general: { name: "general" },
    },
    members: [
      { id: "1", username: "alice", displayName: "Sadiwii" },
      { id: "2", username: "bob" },
      { id: "3", username: "carl", roles: ["guild"] },
      { id: "4", username: "sam", roles: ["staff"] },
      { id: "9", username: "olga" },
      { id: "50", username: "music", bot: true },
    ],
  });
  Object.assign(t.ctx, { features: { enabled: () => false } });
  return t;
}

const voice = (t: TestHarness, u: VoiceStateUpdate) => plugin.events!.voiceStateUpdate!(t.ctx, u);

/** Joins a hub: returns the room created for the member (and checks they were moved there). */
async function joinHub(t: TestHarness, user: string, hub = "create") {
  await voice(t, t.setVoice(user, hub));
  const created = t.createdChannels.at(-1)!;
  return created.channel;
}

const text = (r: ReplyInput | undefined) => (typeof r === "string" ? r : (r?.content ?? ""));

describe("join to create", () => {
  test("a member joining a hub gets a room of their own and is moved into it", async () => {
    const t = setup();
    const room = await joinHub(t, "1");
    expect(t.createdChannels).toHaveLength(1);
    expect(t.createdChannels[0]!.options).toEqual({
      name: "🔊 Sadiwii's channel",
      type: "voice",
      category: { id: "300" },
    });
    // Created without overwrites (it gets the category's), then the owner's and the bot's.
    expect(t.overwrites(room.id)).toEqual({
      "member:1": { allow: ["ViewChannel", "Connect", "Speak", "Stream", "MoveMembers"], deny: [] },
      "member:bot": { allow: ["ViewChannel", "Connect", "MoveMembers"], deny: [] },
    });
    expect(t.voiceMoves).toEqual([
      { member: "1", channel: room.id, reason: "voice-rooms: new room" },
    ]);
    expect(t.voiceChannel("1")).toBe(room.id);
    expect(t.kv.get(`room:${room.id}`)).toMatchObject({ hub: "500", owner: "1", n: 1 });

    // The bot's move is a hub → room update: nothing more happens.
    await voice(t, t.setVoice("1", room.id));
    expect(t.createdChannels).toHaveLength(1);
  });

  test("a second hub has its own template, category, limit and allowed roles", async () => {
    const t = setup();
    await voice(t, t.setVoice("2", "create-guild"));
    expect(t.createdChannels).toHaveLength(0);
    expect(t.voiceMoves).toEqual([
      { member: "2", channel: null, reason: "voice-rooms: not allowed to use this hub" },
    ]);

    const room = await joinHub(t, "3", "create-guild");
    expect(t.createdChannels[0]!.options).toEqual({
      name: "Guild #1",
      type: "voice",
      category: "guilds",
      userLimit: 5,
    });
    expect(room.categoryId).toBe("301");
    // Numbers are per hub, and reused once free.
    const t2 = setup();
    t2.addMember({ id: "7", roles: ["guild"] });
    t2.addMember({ id: "8", roles: ["guild"] });
    const first = await joinHub(t2, "7", "create-guild");
    await joinHub(t2, "3", "create-guild");
    expect(t2.createdChannels.map((c) => c.channel.name)).toEqual(["Guild #1", "Guild #2"]);
    await voice(t2, t2.setVoice("7", null));
    expect(t2.deletedChannels.map((d) => d.id)).toEqual([first.id]);
    await joinHub(t2, "8", "create-guild");
    expect(t2.createdChannels.at(-1)!.channel.name).toBe("Guild #1");
  });

  test("an owner joining the hub again goes back to their room", async () => {
    const t = setup();
    const room = await joinHub(t, "1");
    await t.ctx.server.voiceMembers(room); // the room is not empty (alice is in it)
    t.setVoice("2", room.id);
    await voice(t, t.setVoice("1", "create"));
    expect(t.createdChannels).toHaveLength(1);
    expect(t.voiceChannel("1")).toBe(room.id);
    expect(t.voiceMoves.at(-1)).toEqual({
      member: "1",
      channel: room.id,
      reason: "voice-rooms: back to their room",
    });
  });

  test("the cooldown disconnects a member who asks for rooms too fast", async () => {
    const t = setup({ cooldownSeconds: 60 });
    t.addMember({ id: "70", username: "speedy" }); // a member of this test only (module state)
    await joinHub(t, "70");
    await voice(t, t.setVoice("70", null)); // empty: deleted
    await voice(t, t.setVoice("70", "create"));
    expect(t.createdChannels).toHaveLength(1);
    expect(t.voiceMoves.at(-1)).toEqual({
      member: "70",
      channel: null,
      reason: "voice-rooms: rooms are created at most every 60 s",
    });
  });

  test("mute and other updates in the same channel are ignored", async () => {
    const t = setup();
    const room = await joinHub(t, "1");
    await voice(t, { ...t.setVoice("1", room.id), selfMute: true }); // the bot's move
    await voice(t, { ...t.setVoice("1", room.id), selfMute: true }); // muted
    expect(t.createdChannels).toHaveLength(1);
    expect(t.deletedChannels).toEqual([]);
  });

  test("a member who left voice before the move: the room is deleted at once", async () => {
    const t = setup();
    const update = t.setVoice("1", "create");
    t.setVoice("1", null);
    await voice(t, update);
    expect(t.createdChannels).toHaveLength(1);
    expect(t.deletedChannels.map((d) => d.id)).toEqual([t.createdChannels[0]!.channel.id]);
    expect([...t.kv.keys()]).toEqual([]);
  });
});

describe("empty rooms", () => {
  test("a room is deleted when the last member leaves; bots do not keep it", async () => {
    const t = setup();
    const room = await joinHub(t, "1");
    t.setVoice("2", room.id);
    t.setVoice("50", room.id);
    await voice(t, t.setVoice("1", "afk"));
    expect(t.deletedChannels).toEqual([]);
    await voice(t, t.setVoice("2", null));
    expect(t.deletedChannels).toEqual([{ id: room.id, reason: "voice-rooms: empty" }]);
    expect(t.kv.has(`room:${room.id}`)).toBe(false);
    expect(t.voiceChannel("50")).toBeUndefined(); // disconnected with the channel
  });

  test("with a grace delay, the cleanup task deletes the room only if it is still empty", async () => {
    const t = setup({ emptyDelaySeconds: 30 });
    const room = await joinHub(t, "1");
    await voice(t, t.setVoice("1", null));
    expect(t.deletedChannels).toEqual([]);
    const first = t.scheduled[0]!;
    expect(first).toMatchObject({ delayMs: 30000, task: "cleanup", payload: { room: room.id } });
    await voice(t, t.setVoice("1", room.id));
    await plugin.tasks!.cleanup!(t.ctx, first.payload);
    expect(t.deletedChannels).toEqual([]);
    await voice(t, t.setVoice("1", null));
    const second = t.scheduled[0]!;
    expect(second.id).not.toBe(first.id);
    const due = (second.payload as { due: number }).due;
    vi.useFakeTimers();
    try {
      vi.setSystemTime(due);
      await plugin.tasks!.cleanup!(t.ctx, first.payload);
      expect(t.deletedChannels).toEqual([]);
      await plugin.tasks!.cleanup!(t.ctx, second.payload);
    } finally {
      vi.useRealTimers();
    }
    expect(t.deletedChannels.map((d) => d.id)).toEqual([room.id]);
  });

  test("the sweep deletes empty rooms and forgets rooms deleted by hand", async () => {
    const t = setup();
    const kept = await joinHub(t, "1");
    const empty = await joinHub(t, "2");
    t.setVoice("2", null); // no event: missed while disconnected
    await plugin.schedules!.sweep!.run(t.ctx);
    expect(t.deletedChannels.map((d) => d.id)).toEqual([empty.id]);
    expect(t.kv.has(`room:${kept.id}`)).toBe(true);
  });

  test("on start, rooms are adopted (checked later) or deleted", async () => {
    const t = setup();
    const room = await joinHub(t, "1");
    await plugin.onStart!(t.ctx);
    expect(t.scheduled.at(-1)).toMatchObject({ task: "sweep", delayMs: 15_000 });
    expect(t.deletedChannels).toEqual([]);

    const d = setup({ onRestart: "delete" });
    const r2 = await joinHub(d, "1");
    await plugin.onStart!(d.ctx);
    expect(d.deletedChannels).toEqual([{ id: r2.id, reason: "voice-rooms: plugin restarted" }]);
    expect(d.voiceChannel("1")).toBeUndefined();
    expect(room.id).toBeTruthy();
  });
});

describe("/voice", () => {
  async function withRoom(config: Record<string, unknown> = {}) {
    const t = setup(config);
    const room = await joinHub(t, "1");
    t.setVoice("2", room.id);
    return { t, room };
  }

  test("the owner renames and limits their room from its chat or from anywhere", async () => {
    const { t, room } = await withRoom();
    let r = await runCommand(plugin, t, "voice rename", {
      user: "1",
      channel: room.id,
      options: { name: "Chill" },
    });
    expect(text(r.replies[0])).toBe("Renamed to **Chill**.");
    expect(room.name).toBe("Chill");
    r = await runCommand(plugin, t, "voice limit", { user: "1", options: { count: 3 } });
    expect(text(r.replies[0])).toBe("Limit set to 3.");
    expect(t.editedChannels.at(-1)).toMatchObject({ id: room.id, options: { userLimit: 3 } });
    // Discord's two renames per 10 minutes.
    await runCommand(plugin, t, "voice rename", { user: "1", options: { name: "Two" } });
    r = await runCommand(plugin, t, "voice rename", { user: "1", options: { name: "Three" } });
    expect(text(r.replies[0])).toContain("two renames per 10 minutes");
    expect(room.name).toBe("Two");
  });

  test("only the owner and the staff manage a room", async () => {
    const { t, room } = await withRoom();
    let r = await runCommand(plugin, t, "voice limit", { user: "2", options: { count: 2 } });
    expect(text(r.replies[0])).toBe(
      `<#${room.id}> belongs to <@1>: only they (or the staff) can change it.`,
    );
    t.setVoice("4", room.id);
    r = await runCommand(plugin, t, "voice limit", { user: "4", options: { count: 2 } });
    expect(text(r.replies[0])).toBe("Limit set to 2.");
    r = await runCommand(plugin, t, "voice lock", { user: "9", channel: room.id }); // server owner
    expect(text(r.replies[0])).toContain("Locked");
    r = await runCommand(plugin, t, "voice lock", { user: "3" }); // in no room
    expect(text(r.replies[0])).toBe(
      "Join your voice room first (or use this command in its chat).",
    );
  });

  test("lock, unlock, permit and kick patch the room's overwrites", async () => {
    const { t, room } = await withRoom();
    await runCommand(plugin, t, "voice lock", { user: "1" });
    expect(t.overwrites(room.id)["@everyone"]).toEqual({ allow: [], deny: ["Connect"] });
    await runCommand(plugin, t, "voice permit", {
      user: "1",
      options: { member: t.member("3")!.user },
    });
    expect(t.overwrites(room.id)["member:3"]).toEqual({
      allow: ["ViewChannel", "Connect"],
      deny: [],
    });
    const r = await runCommand(plugin, t, "voice kick", {
      user: "1",
      options: { member: t.member("2")!.user },
    });
    expect(text(r.replies[0])).toContain("<@2> is out of");
    expect(t.overwrites(room.id)["member:2"]).toEqual({ allow: [], deny: ["Connect"] });
    expect(t.voiceChannel("2")).toBeUndefined();
    await runCommand(plugin, t, "voice unlock", { user: "1" });
    expect(t.overwrites(room.id)["@everyone"]).toEqual({ allow: [], deny: [] });
    // The owner's own overwrite is untouched by all this.
    expect(t.overwrites(room.id)["member:1"]!.allow).toContain("Connect");
    const self = await runCommand(plugin, t, "voice kick", {
      user: "1",
      options: { member: t.member("1")!.user },
    });
    expect(text(self.replies[0])).toBe(
      "You cannot kick yourself, the bot or the owner of the room.",
    );
  });

  test("lock also denies Connect to the hub's allowed roles", async () => {
    const t = setup();
    const room = await joinHub(t, "3", "create-guild");
    await runCommand(plugin, t, "voice lock", { user: "3" });
    expect(t.overwrites(room.id)).toMatchObject({
      "@everyone": { deny: ["Connect"] },
      guild: { deny: ["Connect"] },
    });
  });

  test("transfer gives the room to a member in it", async () => {
    const { t, room } = await withRoom();
    let r = await runCommand(plugin, t, "voice transfer", {
      user: "1",
      options: { member: t.member("3")!.user },
    });
    expect(text(r.replies[0])).toBe(`<@3> must be in <#${room.id}> to receive it.`);
    r = await runCommand(plugin, t, "voice transfer", {
      user: "1",
      options: { member: t.member("2")!.user },
    });
    expect(text(r.replies[0])).toBe(`<#${room.id}> now belongs to <@2>.`);
    expect(t.overwrites(room.id)["member:1"]).toBeUndefined();
    expect(t.overwrites(room.id)["member:2"]!.allow).toEqual([
      "ViewChannel",
      "Connect",
      "Speak",
      "Stream",
      "MoveMembers",
    ]);
    expect(t.kv.get(`room:${room.id}`)).toMatchObject({ owner: "2" });
    r = await runCommand(plugin, t, "voice limit", { user: "1", options: { count: 1 } });
    expect(text(r.replies[0])).toContain("belongs to <@2>");
  });

  test("a guild room only goes to a member with a role of its hub (or staff)", async () => {
    const t = setup();
    const room = await joinHub(t, "3", "create-guild");
    t.setVoice("2", room.id); // a guest, let in
    let r = await runCommand(plugin, t, "voice transfer", {
      user: "3",
      options: { member: t.member("2")!.user },
    });
    expect(text(r.replies[0])).toBe(
      `<@2> cannot own <#${room.id}>: it is for the roles of its hub.`,
    );
    await voice(t, t.setVoice("3", null));
    r = await runCommand(plugin, t, "voice claim", { user: "2" });
    expect(text(r.replies[0])).toBe(
      `You cannot own <#${room.id}>: it is for the roles of its hub.`,
    );
    expect(t.kv.get(`room:${room.id}`)).toMatchObject({ owner: "3" });
    t.setVoice("4", room.id); // staff
    r = await runCommand(plugin, t, "voice claim", { user: "4" });
    expect(text(r.replies[0])).toBe(`<#${room.id}> is yours now.`);
  });

  test("claim takes over a room whose owner left", async () => {
    const { t, room } = await withRoom();
    let r = await runCommand(plugin, t, "voice claim", { user: "2" });
    expect(text(r.replies[0])).toBe(
      `<@1> is still in <#${room.id}>: ask them for \`/voice transfer\`.`,
    );
    await voice(t, t.setVoice("1", "afk"));
    r = await runCommand(plugin, t, "voice claim", { user: "2" });
    expect(text(r.replies[0])).toBe(`<#${room.id}> is yours now.`);
    expect(t.kv.get(`room:${room.id}`)).toMatchObject({ owner: "2" });
    r = await runCommand(plugin, t, "voice claim", { user: "3" });
    expect(text(r.replies[0])).toBe("Join the voice room you want to claim first.");
  });
});

describe("0.2 room lifecycle", () => {
  test("owner and guest erasure preserves the shared room and subsequent staff decisions", async () => {
    const t = setup(),
      room = await joinHub(t, "1");
    const opt = (id: string) => ({ member: t.member(id)!.user });
    await voice(t, t.setVoice("2", room.id));
    await voice(t, t.setVoice("3", room.id));
    await runCommand(plugin, t, "voice permit", { user: "1", options: opt("2") });
    await runCommand(plugin, t, "voice permit", { user: "1", options: opt("3") });
    await t.ctx.server.editChannel(room, { overwrites: { "member:2": { deny: ["Connect"] } } });
    const record = await plugin.privacy!.export(t.ctx, "2");
    expect(JSON.stringify(record)).toContain('"access":"permit"');
    expect(JSON.stringify(record)).not.toContain('"owner":"1"');
    await plugin.privacy!.erase(t.ctx, "2");
    expect(t.overwrites(room.id)["member:2"]).toEqual({ allow: [], deny: ["Connect"] });
    expect(t.overwrites(room.id)["member:3"]?.allow).toContain("Connect");
    await plugin.privacy!.erase(t.ctx, "1");
    expect(t.deletedChannels).toEqual([]);
    expect(t.overwrites(room.id)["member:1"]).toBeUndefined();
    expect(t.voiceChannel("3")).toBe(room.id);
    expect(await plugin.privacy!.export(t.ctx, "1")).toEqual([]);
    await runCommand(plugin, t, "voice claim", { user: "3", channel: room.id });
    expect(t.kv.get("room:" + room.id)).toMatchObject({ owner: "3" });
    expect(t.overwrites(room.id)["member:bot"]?.allow).toContain("MoveMembers");
  });
  test("server events have stable keys, the observed human peak and elapsed minutes", async () => {
    const t = setup({ locale: "fr" });
    Object.assign(t.ctx, { features: { enabled: () => true } });
    const published = vi.fn().mockResolvedValue(undefined);
    Object.assign(t.ctx, { events: { publish: published } });
    vi.useFakeTimers();
    try {
      const room = await joinHub(t, "1");
      expect(room.name).toBe("🔊 Salon de Sadiwii");
      await voice(t, t.setVoice("2", room.id));
      await voice(t, t.setVoice("50", room.id));
      vi.setSystemTime(Date.now() + 185000);
      await voice(t, t.setVoice("1", null));
      await voice(t, t.setVoice("2", null));
      await plugin.tasks!.cleanup!(t.ctx, { room: room.id });
      expect(published.mock.calls).toEqual([
        [
          "roomCreated",
          { channelId: room.id, ownerId: "1" },
          { version: 1, idempotencyKey: "create:" + room.id },
        ],
        [
          "roomClosed",
          { channelId: room.id, ownerId: "1", peak: 2, durationMinutes: 3 },
          { version: 1, idempotencyKey: "close:" + room.id },
        ],
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
  test("legacy ownership is exported and revoked without lifting unattributed guest restrictions", async () => {
    const t = setup(),
      room = await joinHub(t, "1");
    await t.ctx.kv.set("room:" + room.id, {
      hub: "500",
      owner: "1",
      createdAt: new Date().toISOString(),
      n: 1,
    });
    await t.ctx.server.editChannel(room, { overwrites: { "member:2": { deny: ["Connect"] } } });
    await plugin.tasks!.sweep!(t.ctx, {});
    expect(await plugin.privacy!.export(t.ctx, "2")).toMatchObject([
      { legacyDiscordOverride: true, policy: "retain" },
    ]);
    await plugin.privacy!.erase(t.ctx, "2");
    expect(t.overwrites(room.id)["member:2"]?.deny).toContain("Connect");
    await plugin.privacy!.erase(t.ctx, "1");
    expect(t.overwrites(room.id)["member:1"]).toBeUndefined();
  });
});

test("erasing a former owner removes the member-derived name after a transfer", async () => {
  const t = setup(),
    room = await joinHub(t, "1");
  await voice(t, t.setVoice("2", room.id));
  await runCommand(plugin, t, "voice transfer", {
    user: "1",
    options: { member: t.member("2")!.user },
  });
  expect(await plugin.privacy!.export(t.ctx, "1")).toMatchObject([
    { owns: false, name: "🔊 Sadiwii's channel" },
  ]);
  await plugin.privacy!.erase(t.ctx, "1");
  expect(t.channel(room.id)!.name).toBe("Voice room 1");
  expect(t.kv.get("room:" + room.id)).toMatchObject({ owner: "2" });
});
