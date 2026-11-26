import type { EventMeta, InteropCall, Json, Message } from "@cicord/sdk";
import { callRoute, createTestContext, runCommand, runComponent } from "@cicord/sdk/testing";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import en from "../locales/en.json" with { type: "json" };
import schema from "../config.schema.json" with { type: "json" };
import plugin from "../src/index.ts";

type Options = Parameters<typeof createTestContext>[0];
function setup(config: Record<string, unknown> = {}, options: Options = {}) {
  return createTestContext({
    schema,
    locales: { en },
    config: { xpPerMessage: 10, cooldownSeconds: 0, ...config },
    roles: {
      muted: { name: "Muted" },
      booster: { name: "Booster" },
      regular: { name: "Regular" },
      veteran: { name: "Veteran" },
      elder: { name: "Elder" },
    },
    channels: {
      general: { name: "general" },
      boosted: { name: "boosted" },
      talk: { name: "Talk", type: "voice" },
      afk: { name: "AFK", type: "voice" },
    },
    members: [
      { id: "1", username: "alice" },
      { id: "2", username: "bob" },
      { id: "3", username: "mia", roles: ["muted"] },
      { id: "4", username: "kai", roles: ["booster"] },
      { id: "9", username: "owner" },
    ],
    server: { ownerId: "9" },
    ...options,
  });
}
type Harness = ReturnType<typeof setup>;

async function say(h: Harness, uid: string, channel = "general"): Promise<Message> {
  const message = h.receive(channel, h.member(uid)!.user, "hello there");
  await plugin.events!.messageCreate!(h.ctx, { ...message, member: h.member(uid)! });
  return message;
}
async function drain(h: Harness) {
  for (let job = h.scheduled.shift(); job; job = h.scheduled.shift())
    await plugin.tasks![job.task]!(h.ctx, job.payload);
}
const warned = (h: Harness, key: string) =>
  h.logs.some((l) => l.level === "warn" && l.message.startsWith(key + ": "));
const meta = (id: string, topic: string): EventMeta => ({
  id,
  topic,
  version: topic === "polls.closed" ? 2 : 1,
  at: "2026-11-21T12:00:00Z",
  publisher: { bot: "bot", instance: topic.split(".")[0]!, plugin: topic.split(".")[0]! },
});
const caller = (key: string): InteropCall & { idempotencyKey: string } => ({
  caller: { plugin: "economy", bot: "bot", instance: "economy", source: "x", verified: true },
  idempotencyKey: key,
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-21T12:00:00Z"));
});
afterEach(() => vi.useRealTimers());

describe("degraded mode", () => {
  test("a truncated polls.closed without the pollPages grant degrades with a status line", async () => {
    const h = setup({ pollBonusXp: 5 }, { features: ["pollBonus"] });
    await plugin.subscriptions!["polls.closed"]!(
      h.ctx,
      { pollId: "4", votersTruncated: true, voterCount: 20000 },
      meta("closed-4", "polls.closed"),
    );
    expect(h.scheduled).toEqual([]);
    expect(warned(h, "poll-pages")).toBe(true);
  });

  test("a CSV import skips malformed rows, completes and reports them", async () => {
    const h = setup(
      { importFile: "xp.csv" },
      {
        features: ["importCsv"],
        files: { "xp.csv": "userId,xp\n1,500\nnot,a,row\n2,abc\n\n3,40\n" },
      },
    );
    await plugin.tasks!["import-csv"]!(h.ctx, undefined);
    expect(h.kv.get("xp:1")).toBe(500);
    expect(h.kv.get("xp:3")).toBe(40);
    expect(h.kv.get("xp:2")).toBeUndefined();
    expect(h.kv.get("import:xp.csv")).toBe(true);
    expect(h.logs.find((l) => l.message.startsWith("import-csv: "))?.message).toMatch(
      /2 invalid rows skipped \(rows 3, 4\)/,
    );
  });

  test("a CSV import whose file cannot be read reports it instead of failing forever", async () => {
    const h = setup({ importFile: "missing.csv" }, { features: ["importCsv"], files: {} });
    await plugin.tasks!["import-csv"]!(h.ctx, undefined);
    expect(warned(h, "import-csv")).toBe(true);
    expect(h.kv.get("import:missing.csv")).toBeUndefined();
  });
});

describe("voice XP", () => {
  function voice(config: Record<string, unknown> = {}) {
    return setup(
      { voice: { xpPerMinute: 5, afkChannel: "afk", ...config } },
      { features: ["voiceXp"] },
    );
  }
  async function minute(h: Harness) {
    vi.advanceTimersByTime(60_000);
    const jobs = h.scheduled.splice(0);
    for (const job of jobs) await plugin.tasks![job.task]!(h.ctx, job.payload);
  }
  test("two members talking earn XP per minute, with multipliers", async () => {
    const h = voice();
    await h.ctx.kv.set("xp:4", 0);
    for (const uid of ["1", "4"])
      await plugin.events!.voiceStateUpdate!(h.ctx, h.setVoice(uid, "talk"));
    await minute(h);
    expect(h.kv.get("xp:1")).toBe(5);
    await minute(h);
    expect(h.kv.get("xp:1")).toBe(10);
    // Replaying a minute's task cannot credit it twice (receipt per token and tick).
    const again = { ...h.scheduled[0]! };
    vi.advanceTimersByTime(60_000);
    await plugin.tasks![again.task]!(h.ctx, again.payload);
    await plugin.tasks![again.task]!(h.ctx, again.payload);
    expect(h.kv.get("xp:1")).toBe(15);
  });
  test("role multiplier applies to voice XP", async () => {
    const h = voice();
    Object.assign(h.ctx.config, { roleMultipliers: [{ role: "booster", factor: 2 }] });
    for (const uid of ["1", "4"])
      await plugin.events!.voiceStateUpdate!(h.ctx, h.setVoice(uid, "talk"));
    await minute(h);
    expect([h.kv.get("xp:1"), h.kv.get("xp:4")]).toEqual([5, 10]);
  });
  test("deafened members and AFK channels earn nothing", async () => {
    const h = voice();
    await plugin.events!.voiceStateUpdate!(h.ctx, h.setVoice("2", "talk"));
    await plugin.events!.voiceStateUpdate!(h.ctx, {
      ...h.setVoice("1", "talk"),
      selfDeaf: true,
    });
    expect(h.kv.get("voice:1")).toBeUndefined();
    for (const uid of ["1", "4"])
      await plugin.events!.voiceStateUpdate!(h.ctx, h.setVoice(uid, "afk"));
    await minute(h);
    await minute(h);
    expect(h.kv.get("xp:1")).toBeUndefined();
    expect(h.kv.get("xp:4")).toBeUndefined();
  });
  test("the server AFK channel is excluded without configuration", async () => {
    const h = setup(
      { voice: { xpPerMinute: 5 } },
      { features: ["voiceXp"], server: { ownerId: "9", afkChannelId: "channel-afk" } },
    );
    for (const uid of ["1", "4"])
      await plugin.events!.voiceStateUpdate!(h.ctx, h.setVoice(uid, "afk"));
    expect(h.scheduled).toEqual([]);
  });
  test("without the voiceXp feature (ServerVoiceStates) nothing is tracked", async () => {
    const h = setup({ voice: { xpPerMinute: 5 } });
    for (const uid of ["1", "4"])
      await plugin.events!.voiceStateUpdate!(h.ctx, h.setVoice(uid, "talk"));
    expect(h.scheduled).toEqual([]);
  });
});

describe("multipliers, boosts and no-XP roles", () => {
  test("role and channel multipliers combine; the best role factor counts", async () => {
    const h = setup({
      roleMultipliers: [{ role: "booster", factor: 2 }],
      channelMultipliers: [{ channel: "boosted", factor: 3 }],
    });
    await say(h, "4");
    expect(h.kv.get("xp:4")).toBe(20);
    await say(h, "4", "boosted");
    expect(h.kv.get("xp:4")).toBe(80);
    await say(h, "1", "boosted");
    expect(h.kv.get("xp:1")).toBe(30);
  });
  test("boosts apply only inside their window", async () => {
    const h = setup({
      boosts: [
        { start: "2026-11-21T00:00:00Z", end: "2026-11-22T00:00:00Z", factor: 2 },
        { start: "2026-11-01T00:00:00Z", end: "2026-11-02T00:00:00Z", factor: 10 },
      ],
    });
    await say(h, "1");
    expect(h.kv.get("xp:1")).toBe(20);
    vi.setSystemTime(new Date("2026-11-22T00:00:00Z"));
    await say(h, "1");
    expect(h.kv.get("xp:1")).toBe(30);
  });
  test("members with a no-XP role earn nothing from messages, reactions or bonuses", async () => {
    const h = setup(
      { noXpRoles: ["muted"], reactionXp: 5, bonuses: { approved: 9 } },
      { features: ["pollBonus"] },
    );
    const m = await say(h, "3");
    expect(h.kv.get("xp:3")).toBeUndefined();
    await plugin.events!.reactionAdd!(h.ctx, {
      message: m,
      user: h.member("1")!.user,
      emoji: "👍",
    });
    expect(h.kv.get("xp:3") ?? 0).toBe(0);
    await plugin.subscriptions!["suggestions.statusChanged"]!(
      h.ctx,
      { status: "approved", authorId: "3" },
      meta("s-3", "suggestions.statusChanged"),
    );
    expect(h.kv.get("xp:3") ?? 0).toBe(0);
  });
});

describe("seasons", () => {
  test("an ended season archives scores, resets accounts and serves its archive", async () => {
    const h = setup({ season: { id: "autumn", end: "2026-11-20T00:00:00Z" } });
    for (const [uid, xp] of [
      ["1", 300],
      ["2", 50],
    ] as const) {
      await h.ctx.kv.set("xp:" + uid, xp);
      await h.ctx.kv.ranking("xp").set(uid, xp);
    }
    await plugin.tasks!.season!(h.ctx, undefined);
    await drain(h);
    expect([h.kv.get("xp:1"), h.kv.get("xp:2")]).toEqual([0, 0]);
    expect(h.kv.get("season:autumn")).toBe(true);
    const archive = await callRoute(plugin, h, "GET /seasons/autumn");
    expect(archive.body).toEqual({
      entries: [
        { userId: "1", xp: 300, rank: 1 },
        { userId: "2", xp: 50, rank: 2 },
      ],
    });
    // Replaying the batch changes nothing; new XP starts the new season.
    await plugin.tasks!.season!(h.ctx, undefined);
    await say(h, "1");
    expect(h.kv.get("xp:1")).toBe(10);
    expect((await callRoute(plugin, h, "GET /seasons/autumn")).body).toEqual(archive.body);
  });
  test("a season that has not ended yet archives nothing", async () => {
    const h = setup({ season: { id: "winter", end: "2026-12-21T00:00:00Z" } });
    await h.ctx.kv.set("xp:1", 300);
    await plugin.tasks!.season!(h.ctx, undefined);
    await say(h, "1");
    expect(h.kv.get("xp:1")).toBe(310);
    expect((await callRoute(plugin, h, "GET /seasons/winter")).body).toEqual({ entries: [] });
  });
});

describe("rank card", () => {
  test("renders an image with the themed layers when enabled and granted", async () => {
    const specs: unknown[] = [];
    const h = setup(
      { rankCard: { enabled: true, background: "#101010", foreground: "#eeeeee" } },
      {
        features: ["rankCard"],
        renderImage: async (spec) => {
          specs.push(spec);
          return { data: new Uint8Array([137, 80, 78, 71]), contentType: "image/png" };
        },
      },
    );
    await say(h, "1");
    const r = await runCommand(plugin, h, "rank", { user: "1" });
    const reply = r.replies[0] as { files?: { name: string }[]; content: string };
    expect(reply.files?.map((f) => f.name)).toEqual(["rank.png"]);
    expect(reply.content).toContain("10 XP");
    expect(JSON.stringify(specs[0])).toContain('"text":"10 XP · #1"');
    expect(JSON.stringify(specs[0])).toContain('"background":"#101010"');
  });
  test("falls back to the text card with a status line when rendering fails", async () => {
    const h = setup(
      { rankCard: { enabled: true } },
      {
        features: ["rankCard"],
        renderImage: async () => {
          throw new Error("renderer offline");
        },
      },
    );
    await say(h, "1");
    const r = await runCommand(plugin, h, "rank", { user: "1" });
    const reply = r.replies[0] as { files?: unknown[]; content: string };
    expect(reply.files).toBeUndefined();
    expect(reply.content).toContain("level **0** · 10 XP");
    expect(warned(h, "rank-card")).toBe(true);
  });
  test("without the render grant the text card is used", async () => {
    const h = setup({ rankCard: { enabled: true } });
    await say(h, "1");
    const r = await runCommand(plugin, h, "rank", { user: "1" });
    expect((r.replies[0] as { files?: unknown[] }).files).toBeUndefined();
  });
});

describe("/xp administration", () => {
  const xp = (h: Harness, sub: string, user: string, amount?: number) =>
    runCommand(plugin, h, "xp " + sub, {
      user,
      options: { member: h.member("1")!.user, ...(amount === undefined ? {} : { amount }) },
    });
  test("give, remove and set change a member's XP", async () => {
    const h = setup();
    expect((await xp(h, "give", "9", 150)).replies).toEqual(["150 XP"]);
    expect((await xp(h, "remove", "9", 400)).replies).toEqual(["0 XP"]);
    expect((await xp(h, "set", "9", 42)).replies).toEqual(["42 XP"]);
    expect(h.kv.get("xp:1")).toBe(42);
    expect(await h.ctx.kv.ranking("xp").score("1")).toBe(42);
  });
  test("reset asks for confirmation; only the requesting manager can confirm", async () => {
    const h = setup();
    await xp(h, "set", "9", 42);
    const asked = await xp(h, "reset", "9");
    expect(h.kv.get("xp:1")).toBe(42);
    const id = JSON.stringify(asked.replies[0]).match(/reset:9:1/)?.[0];
    expect(id).toBe("reset:9:1");
    const other = await runComponent(plugin, h, id!, { user: "2" });
    expect(other.replies).toEqual([en.denied]);
    expect(h.kv.get("xp:1")).toBe(42);
    const done = await runComponent(plugin, h, id!, { user: "9" });
    expect(done.updates).toEqual([{ content: "0 XP", components: [] }]);
    expect(h.kv.get("xp:1")).toBe(0);
  });
  test("members without Manage Server are refused", async () => {
    const h = setup();
    expect((await xp(h, "give", "2", 150)).replies).toEqual([en.denied]);
    expect(h.kv.get("xp:1")).toBeUndefined();
  });
});

describe("CSV import", () => {
  test("imports in batches of 100 rows and does not run twice", async () => {
    const lines = ["userId,xp", ...Array.from({ length: 150 }, (_, i) => `${i + 1},${i + 1}`)];
    const h = setup(
      { importFile: "xp.csv" },
      { features: ["importCsv"], files: { "xp.csv": lines.join("\n") } },
    );
    await plugin.tasks!["import-csv"]!(h.ctx, undefined);
    expect(h.kv.get("xp:150")).toBeUndefined();
    await drain(h);
    expect(h.kv.get("xp:150")).toBe(150);
    expect(h.kv.get("import:xp.csv")).toBe(true);
    await h.ctx.kv.set("xp:1", 999);
    await plugin.tasks!["import-csv"]!(h.ctx, undefined);
    expect(h.kv.get("xp:1")).toBe(999);
  });
  test("without the files.read feature nothing is imported", async () => {
    const h = setup({ importFile: "xp.csv" }, { files: { "xp.csv": "userId,xp\n1,5" } });
    await plugin.tasks!["import-csv"]!(h.ctx, undefined);
    expect(h.kv.get("xp:1")).toBeUndefined();
  });
});

describe("reward modes", () => {
  const rewards = [
    { level: 1, role: "regular", keep: false },
    { level: 2, role: "veteran", keep: true },
    { level: 3, role: "elder", keep: false },
  ];
  async function reach(mode: string) {
    const h = setup({ rewards, rewardMode: mode, xpPerMessage: 600 });
    await say(h, "1"); // 600 XP: level 3 at once
    return ["regular", "veteran", "elder"].filter((r) => h.member("1")!.hasRole(r));
  }
  test("stack keeps every reached role", async () =>
    expect(await reach("stack")).toEqual(["regular", "veteran", "elder"]));
  test("replace keeps only the highest", async () =>
    expect(await reach("replace")).toEqual(["elder"]));
  test("configured keeps the highest and roles marked keep", async () =>
    expect(await reach("configured")).toEqual(["veteran", "elder"]));
  test("replace removes a lower role on the next level", async () => {
    const h = setup({ rewards, rewardMode: "replace", xpPerMessage: 100 });
    await say(h, "1");
    expect(h.member("1")!.hasRole("regular")).toBe(true);
    await say(h, "1");
    await say(h, "1");
    expect(["regular", "veteran"].map((r) => h.member("1")!.hasRole(r))).toEqual([false, true]);
  });
});

describe("interop", () => {
  test("grantXp credits once per idempotency key and refuses when disabled", async () => {
    const h = setup();
    const run = (key: string, amount: number) =>
      plugin.actions!.grantXp!.run(h.ctx, { userId: "1", amount }, caller(key));
    expect(await run("a", 30)).toEqual({ xp: 30 });
    expect(await run("a", 30)).toEqual({ xp: 30 });
    expect(await run("b", -10)).toEqual({ xp: 20 });
    expect(h.kv.get("xp:1")).toBe(20);
    Object.assign(h.ctx.config, { enabled: false });
    await expect(run("c", 5)).rejects.toThrow("Levels disabled");
  });
  test("levelUp is published only with the levelEvents feature", async () => {
    const on = setup({ xpPerMessage: 100 }, { features: ["levelEvents"] });
    await say(on, "1");
    expect(on.published).toEqual([
      { topic: "levelUp", payload: { userId: "1", level: 1, previous: 0, xp: 100 } },
    ]);
    const off = setup({ xpPerMessage: 100 });
    await say(off, "1");
    expect(off.published).toEqual([]);
  });
  test("memberLevel and leaderboard queries", async () => {
    const h = setup({ xpPerMessage: 120 });
    await say(h, "1");
    expect(await plugin.queries!.memberLevel!.run(h.ctx, { userId: "1" }, caller("q"))).toEqual({
      xp: 120,
      level: 1,
      rank: 1,
    });
    const board = (await plugin.queries!.leaderboard!.run(h.ctx, { limit: 5 }, caller("q"))) as {
      entries: { userId: string }[];
    };
    expect(board.entries.map((e) => e.userId)).toEqual(["1"]);
  });
});

describe("partner bonuses", () => {
  const bonuses = { approved: 11, starred: 3, attended: 5, roomClosed: 7 };
  test("suggestions, starboard, community-events and voice-rooms credit their members once", async () => {
    const h = setup({ bonuses }, { features: ["pollBonus"] });
    const deliver = async (topic: string, payload: Json, id: string) => {
      await plugin.subscriptions![topic]!(h.ctx, payload, meta(id, topic));
      await drain(h);
    };
    await deliver("suggestions.statusChanged", { status: "approved", authorId: "1" }, "s1");
    await deliver("suggestions.statusChanged", { status: "approved", authorId: "1" }, "s1");
    await deliver("starboard.starred", { authorId: "1" }, "st1");
    await deliver("community-events.ended", { attendees: ["1", "2"] }, "e1");
    await deliver("voice-rooms.roomClosed", { ownerId: "2" }, "v1");
    expect(h.kv.get("xp:1")).toBe(11 + 3 + 5);
    expect(h.kv.get("xp:2")).toBe(5 + 7);
  });
  test("refusals: rejected suggestions, zero bonuses, missing grant, missing receipt", async () => {
    const h = setup({ bonuses: { approved: 11 } }, { features: ["pollBonus"] });
    await plugin.subscriptions!["suggestions.statusChanged"]!(
      h.ctx,
      { status: "rejected", authorId: "1" },
      meta("s2", "suggestions.statusChanged"),
    );
    await plugin.subscriptions!["starboard.starred"]!(
      h.ctx,
      { authorId: "1" },
      meta("st2", "starboard.starred"),
    );
    expect(h.kv.get("xp:1")).toBeUndefined();
    await expect(
      plugin.subscriptions!["suggestions.statusChanged"]!(h.ctx, {
        status: "approved",
        authorId: "1",
      }),
    ).rejects.toThrow("Missing event receipt");
    const ungranted = setup({ bonuses });
    await plugin.subscriptions!["starboard.starred"]!(
      ungranted.ctx,
      { authorId: "1" },
      meta("st3", "starboard.starred"),
    );
    expect(ungranted.kv.get("xp:1")).toBeUndefined();
  });
});

describe("i18n", () => {
  test("every command, subcommand and option has a name and a description in en and fr", async () => {
    const fr = (await import("../locales/fr.json", { with: { type: "json" } })).default as Record<
      string,
      string
    >;
    const catalog = en as Record<string, string>;
    expect(Object.keys(fr).toSorted()).toEqual(Object.keys(catalog).toSorted());
    const wanted: string[] = [];
    const walk = (prefix: string, def: { options?: object; subcommands?: object }) => {
      wanted.push(prefix + ".name", prefix + ".description");
      for (const o of Object.keys(def.options ?? {}))
        wanted.push(prefix + ".options." + o + ".name", prefix + ".options." + o + ".description");
      for (const [s, sub] of Object.entries(def.subcommands ?? {})) walk(prefix + "." + s, sub);
    };
    for (const [name, def] of Object.entries(plugin.commands!)) walk("commands." + name, def);
    expect(wanted.filter((k) => !(k in catalog))).toEqual([]);
    for (const k of wanted.filter((k) => k.endsWith(".name")))
      expect(fr[k]).toMatch(/^[\p{Ll}\p{N}_-]{1,32}$/u);
  });
});
