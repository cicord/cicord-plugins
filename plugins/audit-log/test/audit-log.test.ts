import type { MessagePayload } from "@cicord/sdk";
import { createTestContext } from "@cicord/sdk/testing";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import schema from "../config.schema.json" with { type: "json" };
import plugin from "../src/index.ts";
import { esc, render, snowflakeTime, type Entry } from "../src/log.ts";

const grants = [
  "discord.messages.send",
  "discord.channels.read",
  "storage.kv",
  "scheduler",
  "events.subscribe",
];

function setup(config: Record<string, unknown> = {}) {
  return createTestContext({
    schema,
    config: { channel: "audit", ...config },
    grants,
    plugin: { name: "audit-log" },
    server: { id: "42" },
    roles: { member: { name: "Member" }, mod: { name: "Moderator" } },
    channels: {
      audit: { name: "audit-log" },
      "member-log": { name: "member-log" },
      general: { name: "general" },
      staff: { name: "staff" },
    },
    members: [
      // A snowflake of 2026-11-20 (a new account) and one of 2016.
      { id: "1573125724569600000", username: "alice", roles: ["member"] },
      { id: "150000000000000000", username: "old_*timer*" },
      { id: "9", username: "helper-bot", bot: true },
    ],
  });
}

type Harness = ReturnType<typeof setup>;

const events = plugin.events!;
const descriptions = (t: Harness) =>
  t.sent.map((s) => (s.message as MessagePayload).embeds?.[0]?.description ?? "");

async function flushTask(t: Harness) {
  await plugin.tasks!.flush!(t.ctx, undefined);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-23T10:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("batching", () => {
  test("events are queued, one flush task per batch, posted as one compact embed", async () => {
    const t = setup();
    await events.memberJoin!(t.ctx, t.member("1573125724569600000")!);
    await events.memberJoin!(t.ctx, t.member("150000000000000000")!);
    expect(t.sent).toHaveLength(0);
    expect(t.scheduled).toEqual([{ id: "task-1", delayMs: 10_000, task: "flush" }]);

    await flushTask(t);
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]!.to).toBe("audit");
    const [text] = descriptions(t);
    const lines = text!.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(
      /^<t:\d+:T> 📥 <@1573125724569600000> \*\*alice\*\* joined · account created <t:\d+:R> ⚠️ new account$/,
    );
    expect(lines[1]).toContain("**old\\_\\*timer\\*** joined");
    expect(lines[1]).not.toContain("new account");
    expect((t.sent[0]!.message as MessagePayload).allowedMentions).toEqual({
      users: false,
      roles: false,
      everyone: false,
    });

    // The queue is empty again; the next event starts a new batch.
    expect([...t.kv.keys()].filter((k) => k.startsWith("q:"))).toEqual([]);
    await events.memberLeave!(t.ctx, t.member("1573125724569600000")!.user);
    expect(t.scheduled).toHaveLength(2);
  });

  test("a batch larger than maxPerBatch is cut and the rest is counted", async () => {
    const t = setup({ maxPerBatch: 5 });
    for (let i = 0; i < 8; i++)
      await events.memberLeave!(t.ctx, t.member("150000000000000000")!.user);
    expect(t.scheduled).toHaveLength(1);
    await flushTask(t);
    const lines = descriptions(t)[0]!.split("\n");
    expect(lines).toHaveLength(6);
    expect(lines[5]).toBe("⚠️ …and 3 more events not posted (rate limit).");
  });

  test("batchSeconds: 0 posts right away", async () => {
    const t = setup({ batchSeconds: 0 });
    await events.memberLeave!(t.ctx, t.member("150000000000000000")!.user);
    expect(t.sent).toHaveLength(1);
    expect(t.scheduled).toHaveLength(0);
  });

  test("the sweep only posts a batch whose flush was lost", async () => {
    const t = setup();
    await events.memberLeave!(t.ctx, t.member("150000000000000000")!.user);
    await plugin.schedules!.sweep!.run(t.ctx);
    expect(t.sent).toHaveLength(0); // the flush task is still due
    vi.advanceTimersByTime(71_000);
    await plugin.schedules!.sweep!.run(t.ctx);
    expect(t.sent).toHaveLength(1);
    // The counter was reset: a new entry schedules a new flush.
    await events.memberLeave!(t.ctx, t.member("150000000000000000")!.user);
    expect(t.scheduled).toHaveLength(2);
  });

  test("categories go to their own channel when configured", async () => {
    const t = setup({ batchSeconds: 0, channels: { members: "member-log" } });
    await events.memberLeave!(t.ctx, t.member("150000000000000000")!.user);
    const msg = await t.ctx.server.channel("general").send("hello");
    await events.messageDelete!(t.ctx, { id: msg.id, channel: msg.channel });
    expect(t.sent.map((s) => s.to)).toEqual(["member-log", "general", "audit"]);
  });
});

describe("events", () => {
  test("role and nickname changes, bots ignored", async () => {
    const t = setup({ batchSeconds: 0 });
    const alice = t.member("1573125724569600000")!;
    const role = (key: string) => t.ctx.server.role(key);
    const before = { ...alice, roles: [role("member")], nickname: undefined };
    const after = { ...alice, roles: [role("mod")], nickname: "Ally" };
    await events.memberUpdate!(t.ctx, after, before);
    expect(descriptions(t)).toEqual([
      expect.stringContaining("🏷️ <@1573125724569600000> **alice** nickname: — → Ally"),
      expect.stringContaining(
        "🎭 <@1573125724569600000> **alice** roles: + <@&role-mod> − <@&role-member>",
      ),
    ]);
    await events.memberUpdate!(t.ctx, after, undefined);
    await events.memberJoin!(t.ctx, t.member("9")!);
    expect(t.sent).toHaveLength(2);
  });

  test("deletions name the author seen earlier; edits are off by default; ignored channels", async () => {
    const t = setup({ batchSeconds: 0, ignoredChannels: ["staff"] });
    const general = t.ctx.server.channel("general");
    const authored = { ...(await general.send("x")), author: t.member("150000000000000000")!.user };
    await events.messageCreate!(t.ctx, authored);
    await events.messageUpdate!(t.ctx, authored);
    expect(t.sent).toHaveLength(1); // only the message sent above
    await events.messageDelete!(t.ctx, { id: authored.id, channel: general });
    expect(descriptions(t)[1]).toContain(
      `🗑️ A message by <@150000000000000000> **old\\_\\*timer\\*** was deleted in <#channel-general>`,
    );
    await events.messageDelete!(t.ctx, { id: "123", channel: t.ctx.server.channel("staff") });
    expect(t.sent).toHaveLength(2);
    await events.messageDelete!(t.ctx, { id: "124", channel: general });
    expect(descriptions(t)[2]).toContain("🗑️ A message was deleted in <#channel-general>");
  });

  test("messageEdits: true logs a link to the edited message", async () => {
    const t = setup({ batchSeconds: 0, events: { messageEdits: true } });
    const general = t.ctx.server.channel("general");
    const m = { ...(await general.send("x")), author: t.member("150000000000000000")!.user };
    await events.messageUpdate!(t.ctx, m);
    expect(descriptions(t)[1]).toContain(
      `<@150000000000000000> edited [a message](https://discord.com/channels/42/channel-general/${m.id}) in <#channel-general>`,
    );
  });
});

describe("subscriptions", () => {
  test("moderation.case and polls.closed", async () => {
    const t = setup({ batchSeconds: 0, events: { polls: true } });
    await plugin.subscriptions!["moderation.case"]!(t.ctx, {
      number: 3,
      action: "timeout",
      member: { id: "7", name: "troll" },
      moderator: { id: "8", name: "mia" },
      reason: "spam",
      durationMinutes: 60,
    });
    await plugin.subscriptions!["moderation.case"]!(t.ctx, { action: "warn" }); // malformed
    await plugin.subscriptions!["polls.closed"]!(t.ctx, {
      pollId: "1",
      question: "Game night?",
      winners: ["Friday"],
      voters: ["1", "2"],
      channelId: "5",
      messageId: "6",
    });
    expect(descriptions(t)).toEqual([
      expect.stringContaining("⏳ case #3 · **timeout** <@7> **troll** for 1 h by <@8> — spam"),
      expect.stringContaining(
        "📊 Poll #1 “Game night?” closed: Friday (2 voters) [poll](https://discord.com/channels/42/5/6)",
      ),
    ]);
  });

  test("categories can be turned off", async () => {
    const t = setup({ batchSeconds: 0, events: { moderation: false, joins: false } });
    await plugin.subscriptions!["moderation.case"]!(t.ctx, {
      action: "kick",
      member: { id: "7", name: "x" },
    });
    await plugin.subscriptions!["polls.closed"]!(t.ctx, { pollId: "1" }); // polls: off by default
    await events.memberJoin!(t.ctx, t.member("1573125724569600000")!);
    expect(t.sent).toHaveLength(0);
  });
});

test("helpers", () => {
  expect(esc("a_b*c")).toBe("a\\_b\\*c");
  // Discord's documented example snowflake: 2016-04-30 11:18:25.796 UTC.
  expect(new Date(snowflakeTime("175928847299117063")).toISOString()).toBe(
    "2016-04-30T11:18:25.796Z",
  );
  const many: Entry[] = Array.from({ length: 30 }, (_, i) => ({
    at: 0,
    group: "members",
    icon: "x",
    text: "y".repeat(300) + i,
  }));
  const messages = render(many);
  expect(messages.length).toBeGreaterThan(1);
  for (const m of messages) expect(m.embeds![0]!.description!.length).toBeLessThanOrEqual(3800);
});
