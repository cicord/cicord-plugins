import type { Embed, Message, MessagePayload } from "@cicord/sdk";
import {
  callRoute,
  createTestContext,
  runCommand,
  type TestContextOptions,
} from "@cicord/sdk/testing";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import schema from "../config.schema.json" with { type: "json" };
import plugin from "../src/index.ts";

const grants = [
  "discord.messages.send",
  "discord.messages.manage",
  "discord.channels.read",
  "discord.members.read",
  "discord.members.moderate",
  "discord.dm.send",
  "storage.kv",
  "http.fetch",
  "portal.routes",
  "events.publish",
];

function setup(
  config: Record<string, unknown> = {},
  fetch?: TestContextOptions["fetch"],
  server: TestContextOptions["server"] = { ownerId: "100" },
) {
  return createTestContext({
    schema,
    config: { logChannel: "mod-log", ...config },
    grants,
    plugin: { name: "moderation" },
    server: { name: "Showcase", ...server },
    // Role hierarchy: admin 10 > senior 7 > mod = vip 5 > member 1.
    roles: {
      admin: { name: "Admin", position: 10, permissions: ["Administrator"] },
      senior: { name: "Senior", position: 7 },
      mod: { name: "Moderator", position: 5, permissions: ["ModerateMembers", "KickMembers"] },
      vip: { name: "VIP", position: 5 },
      member: { name: "Member", position: 1 },
    },
    // servers/<server>.yaml spec.access
    access: { admins: { roles: ["admin"] }, moderators: { roles: ["mod"] } },
    channels: { "mod-log": { name: "mod-log" }, general: { name: "general" } },
    members: [
      { id: "1", username: "mia", roles: ["mod"] },
      { id: "2", username: "troll", roles: ["member"] },
      { id: "3", username: "max", roles: ["mod", "member"] },
      { id: "4", username: "sam", roles: ["senior"] },
      { id: "5", username: "vic", roles: ["vip"] },
      { id: "6", username: "ada", roles: ["admin"] },
      { id: "7", username: "abe", roles: ["admin"] },
      { id: "100", username: "owner" },
      { id: "9", username: "helper-bot", bot: true },
    ],
    ...(fetch ? { fetch } : {}),
  });
}

type Harness = ReturnType<typeof setup>;
const user = (t: Harness, id: string) => t.member(id)!.user;
const logs = (t: Harness): Embed[] =>
  t.sent
    .filter((s) => s.to === "mod-log")
    .flatMap((s) => (s.message as MessagePayload).embeds ?? []);
const dms = (t: Harness, id: string) =>
  t.sent.filter((s) => s.to === `dm:${id}`).map((s) => s.message);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-21T12:00:00Z"));
});
afterEach(() => vi.useRealTimers());

describe("/warn", () => {
  test("logs a case, stores an expiring warning and DMs the member", async () => {
    const t = setup({ warningDays: 1 });
    const evidence = {
      id: "a1",
      filename: "proof.png",
      url: "https://cdn.test/proof.png",
      size: 10,
    };
    const r = await runCommand(plugin, t, "warn", {
      user: "1",
      options: { member: user(t, "2"), reason: "spam", evidence },
    });
    expect(r.replies).toEqual(["⚠️ <@2> was warned (case #1). Active warnings: 1."]);
    expect(dms(t, "2")).toEqual(["⚠️ You received a warning on **Showcase**: spam"]);
    expect(logs(t)[0]).toMatchObject({
      title: "Case #1 · Warning",
      image: { url: "https://cdn.test/proof.png" },
      fields: expect.arrayContaining([{ name: "Reason", value: "spam" }]),
    });
    expect((await callRoute(plugin, t, "GET /warnings/2", { viewer: "1" })).body).toMatchObject({
      items: [{ case: 1, reason: "spam", moderator: "1", evidence: "https://cdn.test/proof.png" }],
    });
    vi.advanceTimersByTime(86_401_000);
    expect((await callRoute(plugin, t, "GET /warnings/2", { viewer: "1" })).body).toEqual({
      items: [],
    });
  });

  test("escalates at the configured number of active warnings (array item defaults applied)", async () => {
    const t = setup({
      escalation: [
        { warnings: 2, action: "timeout" },
        { warnings: 3, action: "kick" },
      ],
    });
    for (const reason of ["one", "two"]) {
      await runCommand(plugin, t, "warn", { user: "1", options: { member: user(t, "2"), reason } });
    }
    expect(t.moderation).toEqual([
      {
        member: "2",
        action: "timeout",
        durationMs: 60 * 60_000,
        reason: "automatic: 2 active warnings",
      },
    ]);
    const r = await runCommand(plugin, t, "warn", {
      user: "1",
      options: { member: user(t, "2"), reason: "three" },
    });
    expect(r.followUps).toEqual([
      { content: "Automatic kick after 3 active warnings.", ephemeral: true },
    ]);
    expect(t.moderation.at(-1)).toMatchObject({ action: "kick" });
    // the DM is sent before the kick
    expect(dms(t, "2").at(-1)).toBe("You were kicked from **Showcase**: 3 active warnings");
    expect(logs(t).map((e) => e.title)).toEqual([
      "Case #1 · Warning",
      "Case #2 · Warning",
      "Case #3 · Timeout",
      "Case #4 · Warning",
      "Case #5 · Kick",
    ]);
  });

  test("refuses self-moderation and bots", async () => {
    const t = setup();
    const self = await runCommand(plugin, t, "warn", {
      user: "1",
      options: { member: user(t, "1"), reason: "x" },
    });
    expect(self.replies).toEqual([{ content: "You cannot moderate yourself.", ephemeral: true }]);
    const bot = await runCommand(plugin, t, "warn", {
      user: "1",
      options: { member: user(t, "9"), reason: "x" },
    });
    expect(bot.replies).toEqual([
      { content: "Bots cannot be moderated with these commands.", ephemeral: true },
    ]);
    expect(t.sent).toEqual([]);
  });
});

describe("role hierarchy and staff", () => {
  const refused = (content: string) => [{ content, ephemeral: true }];
  const act = (t: Harness, by: string, command: "warn" | "kick" | "ban" | "timeout", on: string) =>
    runCommand(plugin, t, command, {
      user: by,
      options: {
        member: user(t, on),
        reason: "x",
        ...(command === "timeout" ? { duration: 10 } : {}),
      },
    });

  test("a moderator cannot act on a member ranked above them or at the same height", async () => {
    const t = setup();
    for (const command of ["warn", "timeout", "kick", "ban"] as const) {
      expect((await act(t, "1", command, "4")).replies).toEqual(
        refused("You cannot moderate <@4>: their highest role is not below yours."),
      );
      expect((await act(t, "1", command, "5")).replies).toEqual(
        refused("You cannot moderate <@5>: their highest role is not below yours."),
      );
    }
    expect(t.moderation).toEqual([]);
    expect(t.sent).toEqual([]);
    expect(t.kv.size).toBe(0);
  });

  test("a moderator cannot act on staff (moderator or admin access), even ranked below", async () => {
    const t = setup();
    expect((await act(t, "1", "kick", "3")).replies).toEqual(
      refused("<@3> is staff (moderator access): only an admin can moderate them."),
    );
    expect((await act(t, "1", "ban", "6")).replies).toEqual(
      refused("<@6> is staff (admin access): only an admin can moderate them."),
    );
    expect(t.moderation).toEqual([]);
  });

  test("a moderator can act on a member ranked below them", async () => {
    const t = setup({ dmMembers: false });
    expect((await act(t, "1", "kick", "2")).replies).toEqual(["👢 <@2> was kicked."]);
    expect(t.moderation).toEqual([{ member: "2", action: "kick", reason: "mia: x" }]);
  });

  test("an admin can act on members and moderators ranked below, not on an equal admin", async () => {
    const t = setup({ dmMembers: false });
    expect((await act(t, "6", "timeout", "1")).replies).toEqual([
      "⏳ <@1> is timed out for 10 min.",
    ]);
    expect((await act(t, "6", "kick", "4")).replies).toEqual(["👢 <@4> was kicked."]);
    expect((await act(t, "6", "ban", "7")).replies).toEqual(
      refused("You cannot moderate <@7>: their highest role is not below yours."),
    );
    expect(t.moderation.map((m) => [m.member, m.action])).toEqual([
      ["1", "timeout"],
      ["4", "kick"],
    ]);
  });

  test("the owner can act on anyone (even without roles); nobody can act on the owner", async () => {
    const t = setup({ dmMembers: false });
    expect((await act(t, "100", "ban", "6")).replies).toEqual(["🔨 <@6> was banned."]);
    expect((await act(t, "7", "ban", "100")).replies).toEqual(
      refused("You cannot moderate the server owner."),
    );
    expect((await act(t, "1", "warn", "100")).replies).toEqual(
      refused("You cannot moderate the server owner."),
    );
    expect(t.moderation.map((m) => [m.member, m.action])).toEqual([["6", "ban"]]);
  });

  test("refuses when the hierarchy cannot be verified (owner unknown)", async () => {
    const t = setup({}, undefined, {});
    expect((await act(t, "1", "warn", "2")).replies).toEqual(
      refused(
        "I cannot check the role hierarchy right now (server roles or owner not loaded yet): try again in a moment.",
      ),
    );
    expect(t.kv.size).toBe(0);
  });
});

describe("sanctions", () => {
  test("/timeout, removal, /kick and /ban", async () => {
    const t = setup({ dmMembers: false });
    let r = await runCommand(plugin, t, "timeout", {
      user: "1",
      options: { member: user(t, "2"), duration: 10, reason: "calm down" },
    });
    expect(r.replies).toEqual(["⏳ <@2> is timed out for 10 min."]);
    r = await runCommand(plugin, t, "timeout", {
      user: "1",
      options: { member: user(t, "2"), duration: 0 },
    });
    expect(r.replies).toEqual(["✅ The timeout of <@2> was removed."]);
    await runCommand(plugin, t, "ban", {
      user: "1",
      options: { member: user(t, "2"), reason: "raid", delete_messages: true },
    });
    expect(t.moderation).toEqual([
      { member: "2", action: "timeout", durationMs: 600_000, reason: "mia: calm down" },
      { member: "2", action: "timeout", durationMs: 0, reason: "mia: no reason" },
      { member: "2", action: "ban", reason: "mia: raid", deleteMessagesSeconds: 86_400 },
    ]);
    expect(dms(t, "2")).toEqual([]);
    expect(logs(t).map((e) => e.title)).toEqual([
      "Case #1 · Timeout",
      "Case #2 · Timeout removed",
      "Case #3 · Ban",
    ]);
  });

  test("a failed DM is reported with a follow-up", async () => {
    const t = setup();
    const troll = t.member("2")!;
    vi.spyOn(troll, "send").mockRejectedValue(new Error("Cannot send messages to this user"));
    const r = await runCommand(plugin, t, "kick", { user: "1", options: { member: troll.user } });
    expect(r.replies).toEqual(["👢 <@2> was kicked."]);
    expect(r.followUps).toEqual([
      { content: "⚠️ I could not DM the member (DMs closed?).", ephemeral: true },
    ]);
  });
});

describe("events", () => {
  test("join, leave and nickname/role updates go to the audit log", async () => {
    const t = setup();
    const troll = t.member("2")!;
    await plugin.events!.memberJoin!(t.ctx, troll);
    await plugin.events!.memberLeave!(t.ctx, troll.user);
    const updated = {
      ...troll,
      nickname: "Nice",
      roles: [...troll.roles, t.ctx.server.role("mod")],
    };
    await plugin.events!.memberUpdate!(t.ctx, updated, troll);
    expect(logs(t).map((e) => e.description)).toEqual([
      "📥 <@2> (troll) joined.",
      "📤 <@2> (troll) left.",
      "✏️ <@2>: nickname: — → Nice; roles: +Moderator",
    ]);
  });

  test("flood protection times out and deletes, without reading content", async () => {
    const t = setup({ flood: { messages: 3, seconds: 5, exemptRoles: ["mod"] } });
    const deleted: string[] = [];
    const post = async (id: string) => {
      const member = t.member(id)!;
      await plugin.events!.messageCreate!(t.ctx, {
        id: `m${Math.random()}`,
        content: "",
        author: member.user,
        member,
        channel: t.channel("general")!,
        attachments: [],
        createdAt: new Date(),
        delete: async () => void deleted.push(id),
      } as unknown as Message);
    };
    for (let i = 0; i < 5; i++) await post("1"); // exempt
    await post("2");
    await post("2");
    vi.advanceTimersByTime(6_000);
    await post("2");
    await post("2");
    expect(t.moderation).toEqual([]);
    await post("2");
    expect(t.moderation).toEqual([
      {
        member: "2",
        action: "timeout",
        durationMs: 5 * 60_000,
        reason: "automatic: 3 messages in 5 s",
      },
    ]);
    expect(deleted).toEqual(["2"]);
  });
});

describe("webhook and routes", () => {
  test("cases are mirrored to the webhook", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const t = setup(
      { webhook: { url: "https://discord.com/api/webhooks/1/x", format: "discord" } },
      (url, init) => {
        calls.push({ url, body: JSON.parse(init?.body ?? "null") });
        return { status: 204 };
      },
    );
    await runCommand(plugin, t, "warn", {
      user: "1",
      options: { member: user(t, "2"), reason: "spam" },
    });
    expect(calls).toEqual([
      {
        url: "https://discord.com/api/webhooks/1/x",
        body: {
          content: "Case #1 · Warning: troll — spam (by mia)",
          allowed_mentions: { parse: [] },
        },
      },
    ]);
  });

  test("a failing webhook does not break the command", async () => {
    const t = setup({ webhook: { url: "https://hooks.slack.com/services/x" } }, () => {
      throw new Error("network down");
    });
    const r = await runCommand(plugin, t, "warn", {
      user: "1",
      options: { member: user(t, "2"), reason: "spam" },
    });
    expect(r.replies).toHaveLength(1);
    expect(t.logs.some((l) => l.message === "moderation: webhook failed")).toBe(true);
  });

  test("DELETE /warnings/:userId clears them and logs it", async () => {
    const t = setup();
    await runCommand(plugin, t, "warn", {
      user: "1",
      options: { member: user(t, "2"), reason: "spam" },
    });
    const res = await callRoute(plugin, t, "DELETE /warnings/2", { viewer: "1" });
    expect(res.body).toEqual({ cleared: 1 });
    expect(logs(t).at(-1)?.title).toBe("Case #2 · Warnings cleared");
    expect((await callRoute(plugin, t, "GET /warnings/2", { viewer: "1" })).body).toEqual({
      items: [],
    });
  });
});
