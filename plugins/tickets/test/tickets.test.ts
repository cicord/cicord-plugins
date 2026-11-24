import type { Message } from "@cicord/sdk";
import {
  callRoute,
  createTestContext,
  runCommand,
  runComponent,
  submitModal,
} from "@cicord/sdk/testing";
import { describe, expect, test } from "vite-plus/test";
import schema from "../config.schema.json" with { type: "json" };
import plugin from "../src/index.ts";

const grants = [
  "discord.messages.send",
  "discord.messages.read",
  "discord.channels.read",
  "discord.channels.manage",
  "storage.kv",
  "portal.routes",
];

function setup(config: Record<string, unknown> = {}) {
  return createTestContext({
    schema,
    config: {
      panelChannel: "help-desk",
      category: "support",
      staffRoles: ["support"],
      logChannel: "ticket-log",
      ...config,
    },
    grants,
    plugin: { name: "tickets" },
    roles: { support: { name: "Support" }, member: { name: "Member" } },
    channels: {
      "help-desk": { name: "help-desk" },
      "ticket-log": { name: "ticket-log" },
      support: { name: "Support", type: "category" },
    },
    members: [
      { id: "1", username: "alice", roles: ["member"] },
      { id: "2", username: "sam", roles: ["support"] },
      { id: "3", username: "eve", roles: ["member"] },
    ],
  });
}

type Harness = ReturnType<typeof setup>;

async function openTicket(t: Harness, user = "1") {
  const click = await runComponent(plugin, t, "open", { user, channel: "help-desk" });
  expect(click.modal?.id).toBe("open");
  return submitModal(plugin, t, "open", {
    user,
    fields: { subject: "  Can't join voice ", description: "Since yesterday" },
  });
}

describe("panel", () => {
  test("/ticket-panel posts the panel in the configured channel by default", async () => {
    const t = setup();
    const r = await runCommand(plugin, t, "ticket-panel", { user: "2" });
    expect(r.replies).toEqual(["Ticket panel posted in <#channel-help-desk>."]);
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]).toMatchObject({
      to: "help-desk",
      message: {
        embeds: [{ title: "Need help?", color: "#5865f2" }],
        components: [{ components: [{ type: "button", id: "open", label: "Open a ticket" }] }],
      },
    });
  });

  test("the channel option overrides it", async () => {
    const t = setup();
    await runCommand(plugin, t, "ticket-panel", {
      user: "2",
      options: { channel: { id: "channel-ticket-log", name: "ticket-log", type: "text" } },
    });
    expect(t.sent[0]?.to).toBe("ticket-log");
  });
});

describe("opening", () => {
  test("creates a private channel for the member and the staff", async () => {
    const t = setup();
    const r = await openTicket(t);
    expect(r.deferred).toEqual({ ephemeral: true });
    const [created] = t.createdChannels;
    expect(created?.options).toMatchObject({
      name: "ticket-1",
      category: "support",
      topic: "#1 · Can't join voice · opened by alice",
      overwrites: {
        "@everyone": { deny: ["ViewChannel"] },
        "member:1": { allow: expect.arrayContaining(["ViewChannel", "SendMessages"]) },
        "member:bot": { allow: expect.arrayContaining(["ManageChannels"]) },
        support: { allow: expect.arrayContaining(["ViewChannel"]) },
      },
    });
    expect(r.replies).toEqual([`Your ticket is open: ${created?.channel.mention}`]);
    const welcome = t.sent.find((s) => s.to === created?.channel.id);
    expect(welcome?.message).toMatchObject({
      content: "Hi <@1>, thanks for reaching out! <@&role-support> will be with you shortly.",
      embeds: [{ title: "#1 — Can't join voice", description: "Since yesterday" }],
      components: [{ components: [{ id: "close:1", label: "Close" }] }],
    });
    expect(t.kv.get("stats:opened")).toBe(1);
  });

  test("respects maxOpenPerMember", async () => {
    const t = setup();
    await openTicket(t);
    const again = await runComponent(plugin, t, "open", { user: "1" });
    expect(again.modal).toBeUndefined();
    expect(again.replies).toEqual([
      {
        content: `You already have an open ticket: <#${t.createdChannels[0]?.channel.id}>.`,
        ephemeral: true,
      },
    ]);
    // another member can still open one
    await openTicket(t, "3");
    expect(t.createdChannels.map((c) => c.options.name)).toEqual(["ticket-1", "ticket-2"]);
  });
});

describe("closing", () => {
  async function opened() {
    const t = setup();
    await openTicket(t);
    const channel = t.createdChannels[0]!.channel;
    const welcome = t.sent.find((s) => s.to === channel.id)!;
    return { t, channel, welcome: t.message(welcome.id) as Message };
  }

  test("asks for confirmation, then logs a summary and deletes the channel", async () => {
    const { t, channel, welcome } = await opened();
    const ask = await runComponent(plugin, t, "close:1", { user: "2", message: welcome });
    expect(ask.replies[0]).toMatchObject({
      ephemeral: true,
      components: [{ components: [{ id: "close-confirm:1" }, { id: "close-cancel:1" }] }],
    });
    const done = await runComponent(plugin, t, "close-confirm:1", { user: "2", message: welcome });
    expect(done.updates).toEqual([{ content: "Closing ticket #1…", components: [] }]);
    expect(t.deletedChannels).toEqual([{ id: channel.id, reason: "ticket #1 closed" }]);
    const log = t.sent.find((s) => s.to === "ticket-log");
    expect(log?.message).toMatchObject({
      embeds: [{ title: "Ticket #1 closed — Can't join voice" }],
    });
    expect(t.kv.get("ticket:00000001")).toMatchObject({
      status: "closed",
      closedBy: { id: "2", displayName: "sam" },
    });
    expect([...t.kv.keys()].filter((k) => k.startsWith("open:"))).toEqual([]);
    // the member can open a new ticket again
    expect((await runComponent(plugin, t, "open", { user: "1" })).modal?.id).toBe("open");
  });

  test("only the opener or the staff can close", async () => {
    const { t, welcome } = await opened();
    const r = await runComponent(plugin, t, "close:1", { user: "3", message: welcome });
    expect(r.replies[0]).toMatchObject({ content: expect.stringContaining("Only the member") });
    expect(t.deletedChannels).toEqual([]);
  });

  test("cancel keeps the ticket", async () => {
    const { t, welcome } = await opened();
    const r = await runComponent(plugin, t, "close-cancel:1", { user: "1", message: welcome });
    expect(r.updates).toEqual([{ content: "The ticket stays open.", components: [] }]);
    expect(t.kv.get("ticket:00000001")).toMatchObject({ status: "open" });
  });
});

describe("portal route and activity", () => {
  test("GET /tickets lists tickets newest first with their activity", async () => {
    const t = setup();
    await openTicket(t);
    await openTicket(t, "3");
    const channel = t.createdChannels[0]!.channel;
    const author = t.member("1")!;
    for (let i = 0; i < 2; i++) {
      await plugin.events!.messageCreate!(t.ctx, {
        id: `m${i}`,
        content: "",
        author: author.user,
        member: author,
        channel,
        attachments: [],
        createdAt: new Date("2026-01-01T10:00:00Z"),
      } as unknown as Message);
    }
    const res = await callRoute(plugin, t, "GET /tickets", { viewer: "2" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      items: [
        {
          id: "2",
          subject: "Can't join voice",
          status: "open",
          author: { id: "3", displayName: "eve" },
          messages: 0,
        },
        { id: "1", status: "open", messages: 2, lastActivityAt: "2026-01-01T10:00:00.000Z" },
      ],
    });
    const closedOnly = await callRoute(plugin, t, "GET /tickets?status=closed", { viewer: "2" });
    expect(closedOnly.body).toEqual({ items: [] });
    expect((await callRoute(plugin, t, "GET /tickets?status=nope", { viewer: "2" })).status).toBe(
      400,
    );
    expect((await callRoute(plugin, t, "GET /tickets/1", { viewer: "2" })).body).toMatchObject({
      number: 1,
    });
    expect((await callRoute(plugin, t, "GET /tickets/9", { viewer: "2" })).status).toBe(404);
    expect((await callRoute(plugin, t, "GET /tickets")).status).toBe(401);
  });
});
