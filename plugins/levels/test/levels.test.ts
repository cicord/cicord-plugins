import type { Message, MessagePayload } from "@cicord/sdk";
import { callRoute, createTestContext, runCommand } from "@cicord/sdk/testing";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import schema from "../config.schema.json" with { type: "json" };
import plugin from "../src/index.ts";
import { levelOf, progress, stepXp } from "../src/levels.ts";

const grants = [
  "discord.messages.send",
  "discord.reactions.manage",
  "discord.channels.read",
  "discord.members.read",
  "discord.roles.assign",
  "storage.kv",
  "scheduler",
  "events.subscribe",
  "portal.routes",
  "portal.links",
];

function setup(config: Record<string, unknown> = {}) {
  return createTestContext({
    schema,
    config: {
      xpPerMessage: 100,
      announce: { channel: "level-ups" },
      rewards: [
        { level: 1, role: "regular", keep: false },
        { level: 2, role: "veteran" },
      ],
      ...config,
    },
    grants,
    plugin: { name: "levels" },
    roles: { regular: { name: "Regular" }, veteran: { name: "Veteran" }, mod: { name: "Mod" } },
    channels: {
      general: { name: "general" },
      "level-ups": { name: "level-ups" },
      bots: { name: "bots" },
    },
    members: [
      { id: "1", username: "alice", displayName: "Alice" },
      { id: "2", username: "bob", roles: ["mod"] },
    ],
  });
}

type Harness = ReturnType<typeof setup>;

let seq = 0;
async function say(
  t: Harness,
  userId: string,
  content: string,
  channel = "general",
): Promise<Message> {
  const member = t.member(userId)!;
  const message = {
    id: `m${++seq}`,
    content,
    author: member.user,
    member,
    channel: t.channel(channel)!,
    attachments: [],
    createdAt: new Date(),
    reply: async (m: unknown) => {
      t.sent.push({ to: `reply:${message.id}`, message: m as MessagePayload, id: "r" });
      return message;
    },
    edit: async () => message,
    delete: async () => {},
    react: async (emoji: string) => {
      t.reactions.push({ message: message.id, emoji });
    },
  } as unknown as Message;
  await plugin.events!.messageCreate!(t.ctx, message);
  return message;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-21T12:00:00Z"));
});
afterEach(() => vi.useRealTimers());

test("level curve", () => {
  expect(stepXp(0)).toBe(100);
  expect(levelOf(99)).toBe(0);
  expect(levelOf(100)).toBe(1);
  expect(progress(300)).toEqual({ level: 2, current: 45, needed: 220 });
});

describe("XP from messages", () => {
  test("cooldown, minimum length and ignored channels", async () => {
    const t = setup({ ignoredChannels: ["bots"] });
    await say(t, "1", "hello there");
    await say(t, "1", "second message within the cooldown");
    expect(t.kv.get("xp:1")).toBe(100);
    vi.advanceTimersByTime(61_000);
    await say(t, "1", "ok"); // too short
    await say(t, "1", "spam in the bot channel", "bots");
    expect(t.kv.get("xp:1")).toBe(100);
    await say(t, "1", "after the cooldown");
    expect(t.kv.get("xp:1")).toBe(200);
  });

  test("level-ups: announcement, 🎉 and role rewards (keep: false is replaced)", async () => {
    const t = setup();
    const first = await say(t, "1", "hello there");
    expect(t.sent).toEqual([
      expect.objectContaining({
        to: "level-ups",
        message: expect.objectContaining({ content: "GG <@1>, you reached **level 1**! 🎉" }),
      }),
    ]);
    expect(t.reactions).toEqual([{ message: first.id, emoji: "🎉" }]);
    expect(t.member("1")?.hasRole("regular")).toBe(true);

    vi.advanceTimersByTime(61_000);
    await say(t, "1", "level two please");
    vi.advanceTimersByTime(61_000);
    await say(t, "1", "almost there");
    expect(levelOf(t.kv.get("xp:1") as number)).toBe(2);
    expect(t.member("1")?.hasRole("veteran")).toBe(true);
    expect(t.member("1")?.hasRole("regular")).toBe(false);
  });

  test("without an announcement channel the bot replies to the message", async () => {
    const t = setup({ announce: { react: false } });
    const m = await say(t, "1", "hello there");
    expect(t.sent.map((s) => s.to)).toEqual([`reply:${m.id}`]);
    expect(t.reactions).toEqual([]);
  });
});

describe("reactions", () => {
  test("the author earns XP once per reacting member; removal takes it back", async () => {
    const t = setup({ xpPerMessage: 10, reactionXp: 5 });
    const m = await say(t, "1", "nice screenshot");
    const bob = t.member("2")!.user;
    const partial = { id: m.id, channel: m.channel } as unknown as Message; // like the gateway
    await plugin.events!.reactionAdd!(t.ctx, { message: partial, user: bob, emoji: "👍" });
    await plugin.events!.reactionAdd!(t.ctx, { message: partial, user: bob, emoji: "🔥" });
    expect(t.kv.get("xp:1")).toBe(15);
    await plugin.events!.reactionRemove!(t.ctx, { message: partial, user: bob, emoji: "👍" });
    expect(t.kv.get("xp:1")).toBe(15); // 🔥 is still there
    await plugin.events!.reactionRemove!(t.ctx, { message: partial, user: bob, emoji: "🔥" });
    expect(t.kv.get("xp:1")).toBe(10);
    // self-reactions earn nothing
    await plugin.events!.reactionAdd!(t.ctx, {
      message: partial,
      user: t.member("1")!.user,
      emoji: "👍",
    });
    expect(t.kv.get("xp:1")).toBe(10);
  });
});

describe("commands", () => {
  test("/rank is ephemeral by default and links to the portal leaderboard", async () => {
    const t = setup({ xpPerMessage: 30 });
    await say(t, "1", "hello there");
    const r = await runCommand(plugin, t, "rank", { user: "1" });
    expect(r.replies).toEqual([
      {
        content: "**Alice** — level **0** · 30 XP · rank #1 of 1\n▰▰▰▱▱▱▱▱▱▱ 30/100 XP to level 1",
        components: [
          {
            type: "row",
            components: [
              {
                type: "link",
                label: "Leaderboard",
                emoji: "🏆",
                url: "https://portal.test/leaderboard?cicord_token=test-1",
              },
            ],
          },
        ],
      },
    ]);
    const other = await runCommand(plugin, t, "rank", {
      user: "1",
      options: { member: t.member("2")!.user },
    });
    expect((other.replies[0] as MessagePayload).content).toBe(
      "**bob** has no XP yet. Say hi in the chat!",
    );
  });

  test("/top with a limit and a role filter", async () => {
    const t = setup({ xpPerMessage: 10 });
    await say(t, "1", "hello there");
    await say(t, "2", "hello from bob");
    await say(t, "2", "x".repeat(10));
    await t.ctx.kv.increment("xp:2", 50);
    const all = await runCommand(plugin, t, "top", { user: "1", options: { limit: 1 } });
    expect((all.replies[0] as MessagePayload).embeds?.[0]?.description).toBe(
      "**#1** <@2> — level 0 · 60 XP",
    );
    const mods = await runCommand(plugin, t, "top", {
      user: "1",
      options: { role: { id: "role-mod", key: "mod", name: "Mod", mention: "<@&role-mod>" } },
    });
    expect((mods.replies[0] as MessagePayload).embeds?.[0]).toMatchObject({
      title: "🏆 Top members — Mod",
      description: "**#1** <@2> — level 0 · 60 XP",
    });
  });
});

describe("recap, poll bonus and routes", () => {
  test("daily recap of yesterday, then counters are dropped", async () => {
    const t = setup({ xpPerMessage: 10 });
    await say(t, "1", "hello there");
    await say(t, "2", "hello from bob");
    vi.setSystemTime(new Date("2026-11-22T09:00:00Z"));
    await plugin.schedules!.recap!.run(t.ctx);
    const recap = t.sent.at(-1)?.message as MessagePayload;
    expect(recap.embeds?.[0]?.title).toBe("Yesterday's most active members (2026-11-21)");
    expect(recap.embeds?.[0]?.description).toBe("🥇 <@1> — +10 XP\n🥈 <@2> — +10 XP");
    expect([...t.kv.keys()].filter((k) => k.startsWith("day:"))).toEqual([]);
  });

  test("polls.closed gives every voter bonus XP", async () => {
    const t = setup({ pollBonusXp: 7 });
    await plugin.subscriptions!["polls.closed"]!(t.ctx, { pollId: "1", voters: ["1", "2"] });
    expect(t.kv.get("xp:1")).toBe(7);
    expect(t.kv.get("xp:2")).toBe(7);
    // voters who never chatted still get a name on the public leaderboard
    const lb = await callRoute(plugin, t, "GET /leaderboard");
    expect(lb.body).toMatchObject({ items: [{ displayName: "Alice" }, { displayName: "bob" }] });
  });

  test("GET /leaderboard (public) and GET /me (member)", async () => {
    const t = setup({ xpPerMessage: 120 });
    await say(t, "1", "hello there");
    const lb = await callRoute(plugin, t, "GET /leaderboard?limit=5");
    expect(lb.body).toEqual({
      items: [{ rank: 1, userId: "1", displayName: "Alice", avatarUrl: null, level: 1, xp: 120 }],
    });
    expect((await callRoute(plugin, t, "GET /me")).status).toBe(401);
    expect((await callRoute(plugin, t, "GET /me", { viewer: "1" })).body).toEqual({
      userId: "1",
      rank: 1,
      xp: 120,
      level: 1,
      current: 20,
      needed: 155,
    });
  });
});
