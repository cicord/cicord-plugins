import type { AuditLogEntry, Json, Embed, Message, MessagePayload } from "@cicord/sdk";
import {
  callRoute,
  createTestContext,
  runCommand,
  runComponent,
  type TestContextOptions,
} from "@cicord/sdk/testing";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import en from "../locales/en.json" with { type: "json" };
import fr from "../locales/fr.json" with { type: "json" };
import schema from "../config.schema.json" with { type: "json" };
import plugin from "../src/index.ts";
import { liftBanIfCurrent } from "../src/bans.ts";
import { deliverCase, saveNewCase, type Case } from "../src/moderation.ts";

const grants = [
  "discord.messages.send",
  "scheduler",
  "discord.messages.read",
  "discord.messages.manage",
  "discord.channels.read",
  "discord.members.read",
  "discord.members.moderate",
  "discord.auditlog.read",
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
  const audit: AuditLogEntry[] = [];
  const t = createTestContext({
    locales: { en, fr },
    schema,
    auditEntries: audit,
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
  // Discord issues immutable snowflake IDs independently of the plugin's case numbers.
  let seq = 1000;
  const addEvidence = (action: string, targetId: string, reason?: string) => {
    audit.unshift({
      id: String(++seq),
      at: new Date(),
      action,
      targetId,
      actorId: t.ctx.bot.user.id,
      reason,
      mergeable: false,
      changes: [],
      attribution: {
        kind: "cicord",
        certainty: "confirmed",
        plugin: {
          bot: t.ctx.bot.key,
          instance: t.ctx.plugin.instance,
          plugin: t.ctx.plugin.name,
        },
      },
    });
  };
  const ban = t.ctx.server.ban.bind(t.ctx.server),
    unban = t.ctx.server.unban.bind(t.ctx.server);
  vi.spyOn(t.ctx.server, "ban").mockImplementation(async (id, options) => {
    await ban(id, options);
    addEvidence("member.ban", id, options?.reason);
  });
  vi.spyOn(t.ctx.server, "unban").mockImplementation(async (id, reason) => {
    await unban(id, reason);
    addEvidence("member.unban", id, reason);
  });
  return { ...t, audit };
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
      fields: expect.arrayContaining([{ name: "Reason", value: "spam" }]),
    });
    expect(JSON.stringify(logs(t))).not.toContain(evidence.url);
    expect(JSON.stringify(t.published)).not.toContain(evidence.url);
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
      {
        member: "2",
        action: "ban",
        reason: "[cicord ban #3] mia: raid",
        deleteMessagesSeconds: 86_400,
      },
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
        calls.push({ url, body: init?.json ?? JSON.parse(init?.body ?? "null") });
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

  test("a bound webhook secret takes precedence over the legacy URL", async () => {
    const t = setup({
      webhook: { url: "https://discord.com/api/webhooks/legacy", format: "discord" },
    });
    vi.spyOn(t.ctx.secrets, "has").mockImplementation((name) => name === "WEBHOOK_URL");
    vi.spyOn(t.ctx.secrets, "ref").mockReturnValue(
      "opaque-reference" as ReturnType<typeof t.ctx.secrets.ref>,
    );
    const http = vi.spyOn(t.ctx.http, "fetch").mockResolvedValue({
      status: 204,
      headers: {},
      bytes: async () => new Uint8Array(),
      text: async () => "",
      json: async <T>() => undefined as T,
    });
    await runCommand(plugin, t, "warn", {
      user: "1",
      options: { member: user(t, "2"), reason: "test" },
    });
    expect(http).toHaveBeenCalledTimes(1);
    expect(http.mock.calls[0]).toMatchObject([
      "opaque-reference",
      { method: "POST", json: { allowed_mentions: { parse: [] } } },
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

describe("durable bans", () => {
  test("one expiry releases only its own ban and creates one resolution across redelivery", async () => {
    const t = setup();
    await runCommand(plugin, t, "ban", {
      user: "1",
      options: { member: user(t, "2"), duration: 1, reason: "incident" },
    });
    const expiry = t.scheduled.find((task) => task.task === "expireBan")!;
    expect(expiry.delayMs).toBe(60_000);
    expect(await t.ctx.server.bans()).toHaveLength(1);
    await plugin.tasks!.expireBan!(t.ctx, expiry.payload);
    await plugin.tasks!.expireBan!(t.ctx, expiry.payload);
    expect(await t.ctx.server.bans()).toHaveLength(0);
    expect(await t.ctx.kv.get("cases")).toBe(2);
    expect(await t.ctx.kv.get("case:1")).toMatchObject({ status: "expired" });
    expect(await t.ctx.kv.get("case:2")).toMatchObject({ action: "unban", status: "lifted" });
  });
  test("an older expiration leaves a replacement permanent ban in place", async () => {
    const t = setup();
    const target = user(t, "2");
    await runCommand(plugin, t, "ban", { user: "1", options: { member: target, duration: 1 } });
    const expiry = t.scheduled[0]!;
    await runCommand(plugin, t, "ban", {
      user: "1",
      options: { member: target, reason: "replacement" },
    });
    await plugin.tasks!.expireBan!(t.ctx, expiry.payload);
    expect((await t.ctx.server.bans())[0]?.reason).toBe("[cicord ban #2] mia: replacement");
    expect(await t.ctx.kv.get("case:1")).toMatchObject({ status: "superseded" });
  });
  test("redelivery after Discord unbanned the member completes the reserved resolution", async () => {
    const t = setup();
    await runCommand(plugin, t, "ban", {
      user: "1",
      options: { member: user(t, "2"), duration: 1 },
    });
    const task = t.scheduled[0]!;
    const state = (await t.ctx.kv.get("ban-expiry:1")) as Record<string, Json>;
    const resolution = await t.ctx.kv.increment("cases");
    await t.ctx.kv.set("ban-expiry:1", {
      ...state,
      release: {
        number: resolution,
        member: { id: "2", name: "troll" },
        moderator: null,
        at: new Date().toISOString(),
        action: "unban",
        reason: "expired",
      },
    });
    await t.ctx.server.unban("2", `[cicord unban #${resolution}] expired`);
    await plugin.tasks!.expireBan!(t.ctx, task.payload);
    await plugin.tasks!.expireBan!(t.ctx, task.payload);
    expect(await t.ctx.kv.get("cases")).toBe(2);
    expect(await t.ctx.kv.get("case:2")).toMatchObject({ number: 2, action: "unban" });
    expect(t.moderation.filter((a) => a.action === "unban")).toHaveLength(1);
  });
});

describe("case access and approval", () => {
  test("a member sees their cases and never their staff notes", async () => {
    const t = setup();
    await runCommand(plugin, t, "warn", {
      user: "1",
      options: { member: user(t, "2"), reason: "rule" },
    });
    await runCommand(plugin, t, "note", {
      user: "1",
      options: { member: user(t, "2"), text: "private note" },
    });
    const own = await callRoute(plugin, t, "GET /members/2", { viewer: "2" });
    expect(JSON.stringify(own.body)).toContain("rule");
    expect(JSON.stringify(own.body)).not.toContain("private note");
    expect((await callRoute(plugin, t, "GET /members/2", { viewer: "5" })).status).toBe(403);
    expect(
      JSON.stringify((await callRoute(plugin, t, "GET /members/2", { viewer: "1" })).body),
    ).toContain("private note");
    expect(JSON.stringify(logs(t))).not.toContain("private note");
    const denied = await runCommand(plugin, t, "case void", { user: "1", options: { number: 1 } });
    expect(denied.replies[0]).toBe("Administrator access required.");
    await runCommand(plugin, t, "case void", { user: "100", options: { number: 1 } });
    expect(await t.ctx.kv.get("case:1")).toMatchObject({ status: "void" });
    expect((await callRoute(plugin, t, "GET /warnings/2", { viewer: "1" })).body).toMatchObject({
      items: [],
    });
  });
  test("a purge consumes the owner's exact preview once, excluding later messages", async () => {
    const t = setup();
    const ch = t.ctx.server.channel("general");
    const a = await ch.send("sample");
    await runCommand(plugin, t, "purge", {
      user: "100",
      channel: "general",
      options: { count: 50, contains: "sample" },
    });
    expect(await ch.message(a.id)).toBeDefined();
    const b = await ch.send("sample");
    await runComponent(plugin, t, "purge-confirm:1", { user: "6", channel: "general" });
    expect(await ch.message(a.id)).toBeDefined();
    await runComponent(plugin, t, "purge-confirm:1", { user: "100", channel: "general" });
    expect(await ch.message(a.id)).toBeUndefined();
    expect(await ch.message(b.id)).toBeDefined();
    await runComponent(plugin, t, "purge-confirm:1", { user: "100", channel: "general" });
    expect(await t.ctx.kv.get("cases")).toBe(1);
  });
  test("old cases are indexed in bounded batches and migration can resume", async () => {
    const t = setup();
    for (let n = 1; n <= 30; n++)
      await t.ctx.kv.set(`case:${n}`, {
        number: n,
        member: { id: "2", name: "alice" },
        moderator: null,
        at: new Date().toISOString(),
        reason: "test",
        action: "warn",
      });
    await plugin.onStart!(t.ctx);
    expect(t.scheduled[0]?.task).toBe("migrateCases");
    await plugin.tasks!.migrateCases!(t.ctx, undefined);
    await plugin.onStart!(t.ctx);
    expect(await t.ctx.kv.get("meta:schema")).toBe(3);
    expect((await t.ctx.kv.list({ prefix: "case-user:2:", limit: 100 })).items).toHaveLength(30);
  });
});

describe("ownership and delivery recovery", () => {
  test("a channel deny blocks both the preview and a confirmation issued before revocation", async () => {
    const t = createTestContext({
      locales: { en, fr },
      schema,
      config: { logChannel: "log" },
      grants: [...grants, "discord.channels.manage"],
      server: { everyonePermissions: ["ViewChannel", "ReadMessageHistory"] },
      roles: { staff: { name: "Staff", permissions: ["ManageMessages"] } },
      members: [{ id: "12", roles: ["staff"] }],
      channels: { log: { name: "Log" } },
    });
    const ch = await t.ctx.server.createChannel({
      name: "test",
      overwrites: { staff: { deny: ["ManageMessages"] } },
    });
    const msg = await ch.send("match");
    const call = () =>
      runCommand(plugin, t, "purge", { user: "12", channel: ch.id, options: { count: 10 } });
    await call();
    expect(await t.ctx.kv.get("purge:1")).toBeUndefined();
    await t.ctx.server.editChannel(
      { id: ch.id },
      { overwrites: { staff: { clear: ["ManageMessages"] } } },
    );
    await call();
    expect(await t.ctx.kv.get("purge:1")).toBeDefined();
    await t.ctx.server.editChannel(
      { id: ch.id },
      { overwrites: { staff: { deny: ["ManageMessages"] } } },
    );
    await runComponent(plugin, t, "purge-confirm:1", { user: "12", channel: ch.id });
    expect(await ch.message(msg.id)).toBeDefined();
  });
  test("a replacement with the same reason cannot be released by either expiry or appeal", async () => {
    const t = setup();
    await runCommand(plugin, t, "ban", {
      user: "1",
      options: { member: user(t, "2"), duration: 60 },
    });
    const original = t.audit[0]!;
    await t.ctx.server.unban("2");
    await t.ctx.server.ban("2", { reason: original.reason! });
    Object.assign(t.audit[0]!, {
      actorId: "9",
      attribution: { kind: "human", certainty: "confirmed" },
    });
    expect(await liftBanIfCurrent(t.ctx, "2", 1, { id: "1", name: "staff" }, "review")).toBe(false);
    await plugin.tasks!.expireBan!(t.ctx, { number: 1, user: "2" });
    expect(await t.ctx.server.bans()).toHaveLength(1);
    expect(await t.ctx.kv.get("case:1")).toMatchObject({ status: "superseded" });
    expect(await t.ctx.kv.get("cases")).toBe(1);
  });

  test("a human unban during a reserved release is never recorded as an automatic unban", async () => {
    const t = setup();
    await runCommand(plugin, t, "ban", {
      user: "1",
      options: { member: user(t, "2"), duration: 60 },
    });
    const remove = vi.mocked(t.ctx.server.unban).getMockImplementation()!;
    vi.spyOn(t.ctx.server, "unban").mockImplementation(async (id, reason) => {
      await remove(id, reason);
      Object.assign(t.audit[0]!, {
        actorId: "6",
        attribution: { kind: "human", certainty: "confirmed" },
      });
    });
    await plugin.tasks!.expireBan!(t.ctx, { number: 1, user: "2" });
    expect(await t.ctx.kv.get("case:2")).toBeUndefined();
    expect(await t.ctx.kv.get("case:1")).toMatchObject({ status: "lifted" });
  });

  test("an outage longer than the retained audit window keeps the ban in force", async () => {
    const t = setup();
    await runCommand(plugin, t, "ban", {
      user: "1",
      options: { member: user(t, "2"), duration: 100_000 },
    });
    vi.advanceTimersByTime(45 * 86_400_000);
    await expect(plugin.tasks!.expireBan!(t.ctx, { number: 1, user: "2" })).rejects.toThrow(
      "unconfirmed",
    );
    expect(await t.ctx.server.bans()).toHaveLength(1);
  });

  test("delayed proof uses a durable task; probable or another installation's evidence cannot lift", async () => {
    const t = setup();
    const list = t.ctx.server.auditLog.bind(t.ctx.server);
    let late = true;
    vi.spyOn(t.ctx.server, "auditLog").mockImplementation((query) =>
      late ? Promise.resolve([]) : list(query),
    );
    await runCommand(plugin, t, "ban", {
      user: "1",
      options: { member: user(t, "2"), duration: 60 },
    });
    const task = t.scheduled.find((x) => x.task === "bindBanEvidence")!;
    expect(await t.ctx.kv.get("ban-expiry:1")).not.toHaveProperty("proof");
    await expect(plugin.tasks!.expireBan!(t.ctx, { number: 1, user: "2" })).rejects.toThrow(
      "unconfirmed",
    );
    late = false;
    const entry = t.audit[0]!;
    entry.attribution.certainty = "probable";
    await expect(plugin.tasks!.expireBan!(t.ctx, { number: 1, user: "2" })).rejects.toThrow(
      "unconfirmed",
    );
    entry.attribution.certainty = "confirmed";
    const origin = entry.attribution.plugin!;
    origin.instance = "another";
    await expect(
      liftBanIfCurrent(t.ctx, "2", 1, { id: "1", name: "staff" }, "review"),
    ).rejects.toThrow("unconfirmed");
    origin.instance = t.ctx.plugin.instance;
    await plugin.tasks!.bindBanEvidence!(t.ctx, task.payload);
    expect(await t.ctx.kv.get("ban-expiry:1")).toHaveProperty("proof.entryId", entry.id);
    await plugin.tasks!.expireBan!(t.ctx, { number: 1, user: "2" });
    expect(await t.ctx.server.bans()).toHaveLength(0);
  });

  test("a new attempt never reposts an uncertain staff message after its history window", async () => {
    const t = setup();
    const c: Case = {
      number: 21,
      action: "warn",
      member: { id: "2", name: "member" },
      moderator: { id: "1", name: "staff" },
      reason: "rule",
      at: new Date().toISOString(),
    };
    const remove = t.ctx.kv.delete.bind(t.ctx.kv);
    vi.spyOn(t.ctx.kv, "delete")
      .mockImplementationOnce(async () => {
        throw new Error("lost acknowledgment");
      })
      .mockImplementation(remove);
    await saveNewCase(t.ctx, c);
    vi.advanceTimersByTime(301_000);
    const channel = t.ctx.server.channel("mod-log");
    for (let i = 0; i < 100; i++) await channel.send("later");
    await expect(deliverCase(t.ctx, { number: 21 })).rejects.toThrow(
      "Staff log delivery is uncertain",
    );
    expect(logs(t)).toHaveLength(1);
    expect(await t.ctx.kv.get("case-delivery:21")).toBeDefined();
  });

  test("delivery retries an interrupted event and reconciles a staff message after losing its acknowledgment", async () => {
    const t = setup();
    const c: Case = {
      number: 22,
      action: "warn",
      member: { id: "2", name: "member" },
      moderator: { id: "1", name: "staff" },
      reason: "rule",
      at: new Date().toISOString(),
      evidence: "https://private.test/evidence",
    };
    const send = t.ctx.events.publish.bind(t.ctx.events);
    const emitted: string[] = [];
    let interrupt = true;
    vi.spyOn(t.ctx.events, "publish").mockImplementation(async (topic, payload, opts) => {
      if (opts?.version === 2 && interrupt) {
        interrupt = false;
        throw new Error("interrupted");
      }
      emitted.push(opts!.idempotencyKey!);
      return send(topic, payload, opts);
    });
    await saveNewCase(t.ctx, c);
    expect(emitted).toEqual(["case:22:v1"]);
    expect(await t.ctx.kv.get("case-delivery:22")).toHaveProperty("event1", true);
    const remove = t.ctx.kv.delete.bind(t.ctx.kv);
    let loseAck = true;
    vi.spyOn(t.ctx.kv, "delete").mockImplementation(async (key) => {
      if (key === "case-delivery:22" && loseAck) {
        loseAck = false;
        throw new Error("lost acknowledgment");
      }
      return remove(key);
    });
    await expect(deliverCase(t.ctx, { number: 22 })).rejects.toThrow("lost acknowledgment");
    vi.advanceTimersByTime(300_000);
    await deliverCase(t.ctx, { number: 22 });
    await saveNewCase(t.ctx, c);
    expect(logs(t)).toHaveLength(1);
    expect(emitted).toEqual(["case:22:v1", "case:22:v2"]);
    expect(JSON.stringify(t.published)).not.toContain(c.evidence);
    expect(await t.ctx.kv.get("case-delivery:22")).toBeUndefined();
    await saveNewCase(t.ctx, { ...c, number: 23, action: "note", reason: "staff only" });
    expect(JSON.stringify([...t.sent, ...t.published])).not.toContain("staff only");
  });
});

test("French interactions use the French warning reply and sanction DM", async () => {
  const t = setup({ locale: "fr" });
  const r = await runCommand(plugin, t, "warn", {
    user: "1",
    options: { member: user(t, "2"), reason: "spam" },
  });
  expect(r.replies[0]).toContain("a reçu un avertissement");
  expect(dms(t, "2")[0]).toContain("Vous avez reçu un avertissement");
  expect(logs(t)[0]?.title).toBe("Dossier nº 1 · Avertissement");
});
