import type { Json, Message, MessagePayload, TextChannel } from "@cicord/sdk";
import {
  callRoute,
  createTestContext,
  runCommand,
  runComponent,
  submitModal,
  type RouteCall,
} from "@cicord/sdk/testing";
import { describe, expect, test } from "vite-plus/test";
import schema from "../config.schema.json" with { type: "json" };
import plugin from "../src/index.ts";
import type { MyTicket, MyTicketDetail, StaffTicket, StaffTicketDetail } from "../src/routes.ts";

const grants = [
  "discord.messages.send",
  "discord.messages.read",
  "discord.channels.read",
  "discord.channels.manage",
  "discord.members.read",
  "storage.kv",
  "portal.routes",
];

// 1 alice, 3 eve: members. 2 sam, 4 max: staff role. 5 mona: Cicord moderator without the
// staff role. 6 ada: Cicord admin. 9 olga: server owner.
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
    // As in plugin.yaml: GET /staff (role.members()) needs ServerMembers.
    intents: ["ServerMessages", "MessageContent", "ServerMembers"],
    plugin: { name: "tickets" },
    server: { id: "100", ownerId: "9" },
    access: { admins: { users: ["6"] }, moderators: { roles: ["support", "mods"] } },
    roles: { support: { name: "Support" }, member: { name: "Member" }, mods: { name: "Mods" } },
    channels: {
      "help-desk": { name: "help-desk" },
      "ticket-log": { name: "ticket-log" },
      support: { name: "Support", type: "category" },
    },
    members: [
      { id: "1", username: "alice", roles: ["member"] },
      { id: "2", username: "sam", roles: ["support"] },
      { id: "3", username: "eve", roles: ["member"] },
      { id: "4", username: "max", roles: ["support"] },
      { id: "5", username: "mona", roles: ["mods"] },
      { id: "6", username: "ada", roles: [] },
      { id: "9", username: "olga", roles: [] },
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

const route = (t: Harness, key: string, call: RouteCall = {}) => callRoute(plugin, t, key, call);

async function portalOpen(t: Harness, user = "1", body: Json = {}) {
  return route(t, "POST /tickets", {
    viewer: user,
    body: {
      subject: "Bot is offline",
      description: "It stopped answering an hour ago.",
      ...(body as object),
    },
  });
}

function messageIn(t: Harness, channel: TextChannel, user: string, id = "m1"): Message {
  const member = t.member(user)!;
  return {
    id,
    content: "",
    author: member.user,
    member,
    channel,
    attachments: [],
    createdAt: new Date("2026-01-01T10:00:00Z"),
  } as unknown as Message;
}

const embedsOf = (m: unknown) => (m as MessagePayload).embeds ?? [];

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
    expect(t.kv.get("ticket:00000001")).toMatchObject({
      priority: "normal",
      label: null,
      assignee: null,
      source: "discord",
      events: [{ type: "opened", by: { id: "1" }, detail: "discord" }],
    });
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
    expect(embedsOf(log?.message)[0]?.fields?.map((f) => f.name)).not.toContain("Reason");
    expect(t.kv.get("ticket:00000001")).toMatchObject({
      status: "closed",
      closedBy: { id: "2", displayName: "sam" },
      channelRemoved: true,
      events: [{ type: "opened" }, { type: "closed", by: { id: "2" } }],
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

  test("the server owner and Cicord admins count as staff", async () => {
    for (const user of ["9", "6"]) {
      const { t, welcome } = await opened();
      const r = await runComponent(plugin, t, "close:1", { user, message: welcome });
      expect(r.replies[0]).toMatchObject({
        content: "Close ticket #1? The channel will be deleted.",
      });
    }
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
    for (let i = 0; i < 2; i++)
      await plugin.events!.messageCreate!(t.ctx, messageIn(t, channel, "1", `m${i}`));
    const res = await route(t, "GET /tickets", { viewer: "2" });
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
    const closedOnly = await route(t, "GET /tickets?status=closed", { viewer: "2" });
    expect(closedOnly.body).toEqual({ items: [] });
    expect((await route(t, "GET /tickets?status=nope", { viewer: "2" })).status).toBe(400);
    expect((await route(t, "GET /tickets/1", { viewer: "2" })).body).toMatchObject({
      number: 1,
    });
    expect((await route(t, "GET /tickets/9", { viewer: "2" })).status).toBe(404);
    expect((await route(t, "GET /tickets")).status).toBe(401);
  });
});

describe("access control", () => {
  const staffRoutes: [string, Json?][] = [
    ["GET /tickets"],
    ["GET /tickets/1"],
    ["GET /staff"],
    ["POST /tickets/1/assign", { userId: "me" }],
    ["PATCH /tickets/1", { priority: "high" }],
    ["POST /tickets/1/close", {}],
    ["POST /tickets/1/reopen"],
    ["POST /tickets/1/messages", { content: "hi" }],
  ];

  test("members and moderators without the staff role cannot call staff routes", async () => {
    const t = setup();
    await openTicket(t);
    for (const viewer of ["1", "3", "5"]) {
      for (const [key, body] of staffRoutes) {
        const res = await route(t, key, { viewer, ...(body !== undefined ? { body } : {}) });
        expect([key, viewer, res.status]).toEqual([key, viewer, 403]);
        expect(res.body).toMatchObject({ error: { code: "forbidden" } });
      }
    }
    expect(t.kv.get("ticket:00000001")).toMatchObject({ status: "open", priority: "normal" });
    expect(t.deletedChannels).toEqual([]);
  });

  test("anonymous viewers get 401 everywhere", async () => {
    const t = setup();
    for (const key of ["GET /tickets/mine", "GET /tickets/mine/1", "POST /tickets", "GET /staff"])
      expect((await route(t, key)).status).toBe(401);
  });

  test("the owner and Cicord admins can call staff routes", async () => {
    const t = setup();
    await openTicket(t);
    for (const viewer of ["9", "6"])
      expect((await route(t, "GET /tickets", { viewer })).status).toBe(200);
  });
});

describe("member routes", () => {
  test("POST /tickets opens a ticket like the panel, from the portal", async () => {
    const t = setup();
    const res = await portalOpen(t, "1", { label: "bug" });
    expect(res.status).toBe(201);
    const channel = t.createdChannels[0]!;
    expect(channel.options).toMatchObject({
      name: "ticket-1",
      category: "support",
      topic: "#1 · Bot is offline · opened by alice",
      overwrites: {
        "@everyone": { deny: ["ViewChannel"] },
        "member:1": { allow: expect.arrayContaining(["ViewChannel", "SendMessages"]) },
        support: { allow: expect.arrayContaining(["ViewChannel"]) },
      },
    });
    expect(res.body).toEqual({
      id: "1",
      number: 1,
      subject: "Bot is offline",
      status: "open",
      priority: "normal",
      label: { key: "bug", name: "Bug", emoji: "🐛" },
      assignee: null,
      source: "portal",
      createdAt: expect.any(String),
      closedAt: null,
      lastActivityAt: null,
      channelUrl: `https://discord.com/channels/100/${channel.channel.id}`,
    } satisfies MyTicket);
    const welcome = t.sent.find((s) => s.to === channel.channel.id);
    expect(welcome?.message).toMatchObject({
      content: "Hi <@1>, thanks for reaching out! <@&role-support> will be with you shortly.",
      embeds: [
        {
          title: "#1 — Bot is offline",
          description: "It stopped answering an hour ago.",
          fields: [{ name: "Label", value: "🐛 Bug" }],
        },
      ],
      components: [{ components: [{ id: "close:1" }] }],
    });
    expect(t.kv.get("open:1:1")).toBe(true);
    expect(t.kv.get(`channel:${channel.channel.id}`)).toBe(1);
    expect(t.kv.get("ticket:00000001")).toMatchObject({
      source: "portal",
      label: "bug",
      events: [{ type: "opened", detail: "portal", by: { id: "1", displayName: "alice" } }],
    });
  });

  test("POST /tickets validates its body", async () => {
    const t = setup();
    const bad: Json[] = [
      { subject: "Hi", description: "Long enough description" },
      { subject: "Fine subject", description: "short" },
      { subject: "x".repeat(101), description: "Long enough description" },
      { subject: "Fine subject", description: "x".repeat(1001) },
      { subject: "Fine subject", description: "Long enough description", label: "nope" },
      { subject: "Fine subject", description: "Long enough description", extra: 1 },
      { subject: 42, description: "Long enough description" },
      ["not", "an", "object"],
      null,
    ];
    for (const body of bad) {
      const res = await route(t, "POST /tickets", { viewer: "1", body });
      expect([body, res.status]).toEqual([body, 400]);
      expect(res.body).toMatchObject({ error: { code: "invalid" } });
    }
    expect(t.createdChannels).toEqual([]);
  });

  test("POST /tickets respects maxOpenPerMember (409 limit), shared with Discord", async () => {
    const t = setup();
    await openTicket(t);
    const res = await portalOpen(t);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: { code: "limit" } });
    expect(t.createdChannels).toHaveLength(1);
    // and the other way round
    const t2 = setup({ maxOpenPerMember: 2 });
    expect((await portalOpen(t2)).status).toBe(201);
    expect((await portalOpen(t2)).status).toBe(201);
    expect((await runComponent(plugin, t2, "open", { user: "1" })).modal).toBeUndefined();
  });

  test("GET /tickets/mine lists only the viewer's tickets, open first then newest", async () => {
    const t = setup({ maxOpenPerMember: 3 });
    await portalOpen(t, "1"); // 1
    await portalOpen(t, "3"); // 2 (eve)
    await portalOpen(t, "1"); // 3
    await portalOpen(t, "1"); // 4
    await route(t, "POST /tickets/3/close", { viewer: "2", body: {} });
    const res = await route(t, "GET /tickets/mine", { viewer: "1" });
    expect(res.status).toBe(200);
    const items = (res.body as unknown as { items: MyTicket[] }).items;
    expect(items.map((i) => [i.id, i.status])).toEqual([
      ["4", "open"],
      ["1", "open"],
      ["3", "closed"],
    ]);
    expect(items[2]).toMatchObject({ channelUrl: null, closedAt: expect.any(String) });
    expect((await route(t, "GET /tickets/mine", { viewer: "4" })).body).toEqual({ items: [] });
  });

  test("GET /tickets/mine/:id shows the viewer's ticket, never someone else's", async () => {
    const t = setup();
    await portalOpen(t, "1");
    await route(t, "POST /tickets/1/assign", { viewer: "2", body: { userId: "me" } });
    await route(t, "PATCH /tickets/1", { viewer: "2", body: { priority: "high" } });
    await route(t, "POST /tickets/1/close", { viewer: "2", body: { reason: "Duplicate of #0" } });
    const res = await route(t, "GET /tickets/mine/1", { viewer: "1" });
    expect(res.status).toBe(200);
    const detail = res.body as unknown as MyTicketDetail;
    expect(detail).toMatchObject({
      subject: "Bot is offline",
      description: "It stopped answering an hour ago.",
      status: "closed",
      priority: "high",
      assignee: { displayName: "sam" },
      channelUrl: null,
    });
    expect(detail.assignee).toEqual({ displayName: "sam" });
    expect(detail.events).toEqual([
      { type: "opened", at: expect.any(String), by: { displayName: "alice" }, detail: "portal" },
      { type: "assigned", at: expect.any(String), by: { displayName: "sam" }, detail: "sam" },
      { type: "priority", at: expect.any(String), by: { displayName: "sam" }, detail: "high" },
      // no reason: it is for the staff
      { type: "closed", at: expect.any(String), by: { displayName: "sam" } },
    ]);
    for (const [viewer, path] of [
      ["3", "GET /tickets/mine/1"],
      ["2", "GET /tickets/mine/1"],
      ["1", "GET /tickets/mine/2"],
      ["1", "GET /tickets/mine/abc"],
      ["1", "GET /tickets/mine/0"],
    ] as const) {
      const r = await route(t, path, { viewer });
      expect([viewer, path, r.status]).toEqual([viewer, path, 404]);
    }
  });
});

describe("staff routes", () => {
  async function withTickets() {
    const t = setup({ maxOpenPerMember: 3 });
    await portalOpen(t, "1", { label: "bug" }); // 1
    await openTicket(t, "3"); // 2, from Discord
    await portalOpen(t, "1", { label: "question" }); // 3
    return t;
  }
  const ids = (res: { body: Json | undefined }) =>
    (res.body as unknown as { items: StaffTicket[] }).items.map((i) => i.id);

  test("GET /tickets filters by assignee, priority and label", async () => {
    const t = await withTickets();
    await route(t, "POST /tickets/1/assign", { viewer: "2", body: { userId: "me" } });
    await route(t, "POST /tickets/2/assign", { viewer: "2", body: { userId: "4" } });
    await route(t, "PATCH /tickets/3", { viewer: "2", body: { priority: "urgent" } });
    const all = await route(t, "GET /tickets", { viewer: "2" });
    expect(ids(all)).toEqual(["3", "2", "1"]);
    expect((all.body as unknown as { items: StaffTicket[] }).items[1]).toMatchObject({
      number: 2,
      source: "discord",
      priority: "normal",
      label: null,
      assignee: { id: "4", displayName: "max" },
    });
    expect(ids(await route(t, "GET /tickets?assignee=me", { viewer: "2" }))).toEqual(["1"]);
    expect(ids(await route(t, "GET /tickets?assignee=me", { viewer: "4" }))).toEqual(["2"]);
    expect(ids(await route(t, "GET /tickets?assignee=4", { viewer: "2" }))).toEqual(["2"]);
    expect(ids(await route(t, "GET /tickets?assignee=none", { viewer: "2" }))).toEqual(["3"]);
    expect(ids(await route(t, "GET /tickets?priority=urgent", { viewer: "2" }))).toEqual(["3"]);
    expect(ids(await route(t, "GET /tickets?label=bug", { viewer: "2" }))).toEqual(["1"]);
    expect(ids(await route(t, "GET /tickets?label=none", { viewer: "2" }))).toEqual(["2"]);
    expect(
      ids(await route(t, "GET /tickets?status=open&label=question&assignee=none", { viewer: "2" })),
    ).toEqual(["3"]);
    for (const q of ["assignee=bob", "priority=meh", "label=nope", "status=all"]) {
      const res = await route(t, `GET /tickets?${q}`, { viewer: "2" });
      expect([q, res.status]).toEqual([q, 400]);
    }
  });

  test("GET /tickets/:id reads the last messages of the channel at request time", async () => {
    const t = await withTickets();
    const channel = t.createdChannels[0]!.channel;
    const res = await route(t, "GET /tickets/1", { viewer: "2" });
    expect(res.status).toBe(200);
    const detail = res.body as unknown as StaffTicketDetail;
    expect(detail).toMatchObject({
      id: "1",
      number: 1,
      description: "It stopped answering an hour ago.",
      channelId: channel.id,
      channelUrl: `https://discord.com/channels/100/${channel.id}`,
      closedBy: null,
      closeReason: null,
      summary: null,
      messageCount: 0,
      label: { key: "bug" },
      events: [{ type: "opened", by: { id: "1", displayName: "alice" }, detail: "portal" }],
    });
    // the welcome message, by the bot
    expect(detail.messages).toEqual([
      {
        id: expect.any(String),
        author: { id: "bot", displayName: "TestBot", bot: true },
        content: expect.stringContaining("thanks for reaching out"),
        embeds: expect.any(Array),
        repliedBy: null,
        createdAt: expect.any(String),
      },
    ]);
    // members' messages come with their content (MessageContent), oldest first
    const alice = t.member("1")!;
    const sam = t.member("2")!;
    const asked: unknown[] = [];
    channel.messages = async (options) => {
      asked.push(options);
      return [
        { ...messageIn(t, channel, "2", "m2"), content: "Can you share the logs?", member: sam },
        { ...messageIn(t, channel, "1", "m1"), content: "Still offline", member: alice },
      ] as Message[];
    };
    const again = (await route(t, "GET /tickets/1", { viewer: "2" }))
      .body as unknown as StaffTicketDetail;
    expect(asked).toEqual([{ limit: 50 }]);
    expect(
      again.messages?.map((m) => [m.id, m.author.displayName, m.author.bot, m.content]),
    ).toEqual([
      ["m1", "alice", false, "Still offline"],
      ["m2", "sam", false, "Can you share the logs?"],
    ]);
    // never stored
    expect(JSON.stringify([...t.kv.values()])).not.toContain("Still offline");
    // a closed ticket has no channel any more
    await route(t, "POST /tickets/1/close", { viewer: "2", body: { reason: "Fixed" } });
    const closed = (await route(t, "GET /tickets/1", { viewer: "2" }))
      .body as unknown as StaffTicketDetail;
    expect(closed).toMatchObject({
      status: "closed",
      channelId: channel.id,
      channelUrl: null,
      closeReason: "Fixed",
      closedBy: { id: "2" },
      messages: null,
      events: [{ type: "opened" }, { type: "closed", detail: "Fixed" }],
    });
  });

  test("GET /staff lists the staff roles' members, the owner and the viewer", async () => {
    const t = await withTickets();
    t.addMember({ id: "7", username: "helper-bot", bot: true, roles: ["support"] });
    // sam and max (support), olga (owner); the support bot is not assignable
    const res = await route(t, "GET /staff", { viewer: "2" });
    expect(res.body).toEqual({
      items: [
        { id: "4", displayName: "max" },
        { id: "9", displayName: "olga" },
        { id: "2", displayName: "sam" },
      ],
    });
    // a Cicord admin without a staff role sees themselves; a member who left is gone
    t.removeMember("4");
    const admin = await route(t, "GET /staff", { viewer: "6" });
    expect((admin.body as { items: { id: string }[] }).items.map((p) => p.id)).toEqual([
      "6",
      "9",
      "2",
    ]);
    // nothing is stored for it
    expect([...t.kv.keys()].filter((k) => k.startsWith("staff:"))).toEqual([]);
  });

  test("GET /staff needs the ServerMembers intent", async () => {
    const t = createTestContext({
      schema,
      config: { panelChannel: "help-desk", staffRoles: ["support"] },
      grants,
      intents: ["ServerMessages", "MessageContent"],
      access: { moderators: { roles: ["support"] } },
      roles: { support: { name: "Support" } },
      channels: { "help-desk": { name: "help-desk" } },
      members: [{ id: "2", username: "sam", roles: ["support"] }],
    });
    await expect(route(t, "GET /staff", { viewer: "2" })).rejects.toThrow(/ServerMembers/);
  });

  test("POST /tickets/:id/assign assigns staff only and posts a notice", async () => {
    const t = await withTickets();
    const channel = t.createdChannels[0]!.channel;
    const res = await route(t, "POST /tickets/1/assign", { viewer: "2", body: { userId: "4" } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: "1", assignee: { id: "4", displayName: "max" } });
    const note = t.sent.at(-1)!;
    expect(note).toMatchObject({
      to: channel.id,
      message: { content: "Assigned to **max**." },
      allowedMentions: { users: false, roles: false, everyone: false },
    });
    // same assignee: nothing new
    const sentBefore = t.sent.length;
    await route(t, "POST /tickets/1/assign", { viewer: "2", body: { userId: "4" } });
    expect(t.sent).toHaveLength(sentBefore);
    // owner and admins can be assigned
    expect(
      (await route(t, "POST /tickets/1/assign", { viewer: "2", body: { userId: "9" } })).body,
    ).toMatchObject({
      assignee: { id: "9" },
    });
    for (const body of [
      { userId: "1" }, // not staff
      { userId: "5" }, // moderator without the staff role
      { userId: "12345" }, // not a member
      { userId: "abc" },
      { userId: 4 },
      {},
      { userId: "me", extra: true },
    ] as Json[]) {
      const r = await route(t, "POST /tickets/1/assign", { viewer: "2", body });
      expect([body, r.status]).toEqual([body, 400]);
    }
    const off = await route(t, "POST /tickets/1/assign", { viewer: "4", body: { userId: null } });
    expect(off.body).toMatchObject({ assignee: null });
    expect(t.sent.at(-1)?.message).toMatchObject({ content: "Unassigned by **max**." });
    expect(
      (t.kv.get("ticket:00000001") as { events: { type: string }[] }).events.map((e) => e.type),
    ).toEqual(["opened", "assigned", "assigned", "unassigned"]);
    expect(
      (await route(t, "POST /tickets/99/assign", { viewer: "2", body: { userId: "me" } })).status,
    ).toBe(404);
  });

  test("PATCH /tickets/:id changes priority and label", async () => {
    const t = await withTickets();
    const res = await route(t, "PATCH /tickets/2", {
      viewer: "2",
      body: { priority: "high", label: "self-hosting" },
    });
    expect(res.body).toMatchObject({
      priority: "high",
      label: { key: "self-hosting", name: "Self-hosting", emoji: "🖥️" },
    });
    const cleared = await route(t, "PATCH /tickets/2", { viewer: "2", body: { label: null } });
    expect(cleared.body).toMatchObject({ priority: "high", label: null });
    expect(t.kv.get("ticket:00000002")).toMatchObject({
      events: [
        { type: "opened" },
        { type: "priority", detail: "high", by: { id: "2" } },
        { type: "label", detail: "self-hosting" },
        { type: "label", detail: "none" },
      ],
    });
    for (const body of [
      {},
      { priority: "meh" },
      { label: "nope" },
      { label: 3 },
      { status: "closed" },
      "high",
    ] as Json[]) {
      const r = await route(t, "PATCH /tickets/2", { viewer: "2", body });
      expect([body, r.status]).toEqual([body, 400]);
    }
    expect(
      (await route(t, "PATCH /tickets/42", { viewer: "2", body: { priority: "low" } })).status,
    ).toBe(404);
  });

  test("POST /tickets/:id/close closes like Discord, with the reason in the summary", async () => {
    const t = await withTickets();
    const channel = t.createdChannels[0]!.channel;
    const res = await route(t, "POST /tickets/1/close", {
      viewer: "2",
      body: { reason: "  Fixed in 0.1.5  " },
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: "1",
      status: "closed",
      channelId: null,
      closedAt: expect.any(String),
    });
    expect(t.deletedChannels).toEqual([{ id: channel.id, reason: "ticket #1 closed" }]);
    const log = t.sent.find((s) => s.to === "ticket-log")!;
    expect(embedsOf(log.message)[0]).toMatchObject({
      title: "Ticket #1 closed — Bot is offline",
      fields: expect.arrayContaining([
        { name: "Closed by", value: "<@2>", inline: true },
        { name: "Reason", value: "Fixed in 0.1.5" },
      ]),
    });
    expect(log.allowedMentions).toEqual({ users: false, roles: false, everyone: false });
    expect(t.kv.has("open:1:1")).toBe(false);
    expect(t.kv.has(`channel:${channel.id}`)).toBe(false);
    expect(t.kv.get("stats:closed")).toBe(1);
    const again = await route(t, "POST /tickets/1/close", { viewer: "2" });
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ error: { code: "closed" } });
    // no body is fine; a long reason is not
    expect(
      (await route(t, "POST /tickets/2/close", { viewer: "2", body: { reason: "x".repeat(501) } }))
        .status,
    ).toBe(400);
    expect((await route(t, "POST /tickets/2/close", { viewer: "2" })).status).toBe(200);
  });

  test("POST /tickets/:id/reopen recreates the channel and ignores maxOpenPerMember", async () => {
    const t = setup();
    await portalOpen(t, "1", { label: "bug" });
    const first = t.createdChannels[0]!;
    await route(t, "POST /tickets/1/close", { viewer: "2", body: {} });
    await portalOpen(t, "1"); // ticket 2: alice is at her limit again
    const res = await route(t, "POST /tickets/1/reopen", { viewer: "4" });
    expect(res.status).toBe(200);
    const reopened = t.createdChannels[2]!;
    expect(reopened.options).toEqual(first.options);
    expect(res.body).toMatchObject({
      id: "1",
      status: "open",
      channelId: reopened.channel.id,
      closedAt: null,
    });
    const post = t.sent.at(-1)!;
    expect(post).toMatchObject({
      to: reopened.channel.id,
      message: {
        content: "<@1> Reopened by **max**.",
        embeds: [{ title: "#1 — Bot is offline", fields: [{ name: "Label", value: "🐛 Bug" }] }],
        components: [{ components: [{ id: "close:1" }] }],
      },
      allowedMentions: { users: ["1"], roles: false, everyone: false },
    });
    expect(t.kv.get("open:1:1")).toBe(true);
    expect(t.kv.get(`channel:${reopened.channel.id}`)).toBe(1);
    expect(t.kv.get("ticket:00000001")).not.toHaveProperty("closedAt");
    expect(
      (t.kv.get("ticket:00000001") as { events: { type: string }[] }).events.map((e) => e.type),
    ).toEqual(["opened", "closed", "reopened"]);
    // activity in the new channel counts for the ticket
    await plugin.events!.messageCreate!(t.ctx, messageIn(t, reopened.channel, "1"));
    expect((await route(t, "GET /tickets/1", { viewer: "2" })).body).toMatchObject({
      messageCount: 1,
    });
    // the Close button works in the new channel
    const welcome = t.message(post.id)!;
    expect(
      (await runComponent(plugin, t, "close:1", { user: "1", message: welcome })).replies[0],
    ).toMatchObject({
      content: expect.stringContaining("Close ticket #1?"),
    });
    const twice = await route(t, "POST /tickets/1/reopen", { viewer: "2" });
    expect(twice.status).toBe(409);
    expect(twice.body).toMatchObject({ error: { code: "open" } });
  });

  test("POST /tickets/:id/messages posts as the bot, signed, with no mentions", async () => {
    const t = await withTickets();
    const channel = t.createdChannels[0]!.channel;
    const res = await route(t, "POST /tickets/1/messages", {
      viewer: "2",
      body: { content: "  Restart it with @everyone <@1>  " },
    });
    expect(res.status).toBe(201);
    const id = (res.body as { id: string }).id;
    const post = t.sent.at(-1)!;
    expect(post).toMatchObject({
      id,
      to: channel.id,
      message: {
        embeds: [
          { description: "Restart it with @everyone <@1>", footer: { text: "— sam (via portal)" } },
        ],
      },
      allowedMentions: { users: false, roles: false, everyone: false },
    });
    expect(t.kv.get("ticket:00000001")).toMatchObject({
      events: [{ type: "opened" }, { type: "replied", by: { id: "2" }, detail: id }],
    });
    expect(JSON.stringify([...t.kv.values()])).not.toContain("Restart it");
    const detail = (await route(t, "GET /tickets/1", { viewer: "2" }))
      .body as unknown as StaffTicketDetail;
    expect(detail).toMatchObject({ messageCount: 1 });
    // The conversation shows the reply's text and who wrote it (the author is the bot).
    expect(detail.messages?.at(-1)).toMatchObject({
      id,
      author: { bot: true },
      content: "",
      embeds: [{ title: null, description: "Restart it with @everyone <@1>" }],
      repliedBy: { id: "2", displayName: "sam" },
    });
    for (const body of [
      { content: "   " },
      { content: "x".repeat(2001) },
      { content: 1 },
      {},
    ] as Json[]) {
      const r = await route(t, "POST /tickets/1/messages", { viewer: "2", body });
      expect([body, r.status]).toEqual([body, 400]);
    }
    await route(t, "POST /tickets/1/close", { viewer: "2" });
    const closed = await route(t, "POST /tickets/1/messages", {
      viewer: "2",
      body: { content: "hi" },
    });
    expect(closed.status).toBe(409);
    expect(closed.body).toMatchObject({ error: { code: "closed" } });
  });
});

describe("tickets written by 0.1", () => {
  // The record shape of 0.1.0: no priority, label, assignee, events or source.
  function legacy() {
    const t = setup();
    t.kv.set("seq", 2);
    t.kv.set("ticket:00000001", {
      id: "1",
      number: 1,
      subject: "Old and closed",
      description: "",
      status: "closed",
      author: { id: "1", displayName: "alice" },
      channelId: "555",
      createdAt: "2026-01-01T09:00:00.000Z",
      closedAt: "2026-01-01T10:00:00.000Z",
      closedBy: { id: "2", displayName: "sam" },
      summary: { messages: 3, participants: [{ id: "1", displayName: "alice" }] },
    });
    t.kv.set("ticket:00000002", {
      id: "2",
      number: 2,
      subject: "Old and open",
      description: "Still there",
      status: "open",
      author: { id: "3", displayName: "eve" },
      channelId: "channel-help-desk",
      createdAt: "2026-01-02T09:00:00.000Z",
    });
    t.kv.set("open:3:2", true);
    t.kv.set("channel:channel-help-desk", 2);
    return t;
  }

  test("get the new fields' defaults everywhere", async () => {
    const t = legacy();
    const list = await route(t, "GET /tickets", { viewer: "2" });
    expect((list.body as unknown as { items: StaffTicket[] }).items).toEqual([
      expect.objectContaining({
        id: "2",
        priority: "normal",
        label: null,
        assignee: null,
        source: "discord",
        messages: 0,
      }),
      expect.objectContaining({
        id: "1",
        status: "closed",
        priority: "normal",
        messages: 3,
        channelId: null,
      }),
    ]);
    const detail = (await route(t, "GET /tickets/1", { viewer: "2" }))
      .body as unknown as StaffTicketDetail;
    expect(detail.events).toEqual([
      {
        type: "opened",
        at: "2026-01-01T09:00:00.000Z",
        by: { id: "1", displayName: "alice" },
        detail: "discord",
      },
      { type: "closed", at: "2026-01-01T10:00:00.000Z", by: { id: "2", displayName: "sam" } },
    ]);
    // the author index is built from the old records
    const mine = await route(t, "GET /tickets/mine", { viewer: "1" });
    expect((mine.body as unknown as { items: MyTicket[] }).items.map((i) => i.id)).toEqual(["1"]);
    expect((await route(t, "GET /tickets/mine/2", { viewer: "3" })).body).toMatchObject({
      subject: "Old and open",
      events: [{ type: "opened", by: { displayName: "eve" } }],
    });
    // and they can be changed
    await route(t, "PATCH /tickets/2", { viewer: "2", body: { label: "plugin" } });
    expect(t.kv.get("ticket:00000002")).toMatchObject({
      priority: "normal",
      label: "plugin",
      source: "discord",
      events: [{ type: "opened" }, { type: "label", detail: "plugin" }],
    });
    // a new ticket of alice joins the old ones
    await portalOpen(t, "1");
    expect(
      (
        (await route(t, "GET /tickets/mine", { viewer: "1" })).body as unknown as {
          items: MyTicket[];
        }
      ).items.map((i) => i.id),
    ).toEqual(["3", "1"]);
  });

  test("an old closed ticket whose channel is gone is reopened in a new channel", async () => {
    const t = legacy();
    const res = await route(t, "POST /tickets/1/reopen", { viewer: "2" });
    expect(res.status).toBe(200);
    const [created] = t.createdChannels;
    expect(created?.options).toMatchObject({
      name: "ticket-1",
      overwrites: { "member:1": { allow: expect.arrayContaining(["ViewChannel"]) } },
    });
    expect(res.body).toMatchObject({ status: "open", channelId: created?.channel.id, messages: 3 });
    expect(t.sent.at(-1)).toMatchObject({
      to: created?.channel.id,
      message: { content: "<@1> Reopened by **sam**." },
    });
  });

  test("the Discord close button still works on an old ticket", async () => {
    const t = legacy();
    const msg = await t.channel("help-desk")!.send("old welcome");
    // the old channel is a managed channel here: deleting it fails, the ticket closes anyway
    const r = await runComponent(plugin, t, "close-confirm:2", { user: "2", message: msg });
    expect(r.updates).toEqual([{ content: "Closing ticket #2…", components: [] }]);
    expect(t.kv.get("ticket:00000002")).toMatchObject({ status: "closed", priority: "normal" });
    expect(t.kv.get("ticket:00000002")).toMatchObject({ channelRemoved: false });
    expect(t.logs.some((l) => l.message === "tickets: could not delete the ticket channel")).toBe(
      true,
    );
    // its channel is still there: reopening uses it
    await route(t, "POST /tickets/2/reopen", { viewer: "2" });
    expect(t.createdChannels).toEqual([]);
    expect(t.sent.at(-1)).toMatchObject({
      to: "help-desk",
      message: { content: "<@3> Reopened by **sam**." },
    });
  });

  test("a closed 0.1 ticket gets a new channel even when its old id still resolves", async () => {
    const t = legacy();
    // The runtime may still hand out a channel it saw before it was deleted.
    t.kv.set("ticket:00000001", {
      ...(t.kv.get("ticket:00000001") as object),
      channelId: "channel-ticket-log",
    });
    await route(t, "POST /tickets/1/reopen", { viewer: "2" });
    expect(t.createdChannels).toHaveLength(1);
    expect(t.sent.filter((s) => s.to === "ticket-log")).toEqual([]);
  });
});

describe("channels that the runtime still resolves but Discord deleted", () => {
  const gone = (channel: TextChannel) => {
    channel.messages = async () => {
      throw new Error("Unknown Channel");
    };
  };

  test("reopen creates a new channel and keeps the ticket closed if that fails", async () => {
    const t = setup();
    await openTicket(t);
    const first = t.createdChannels[0]!.channel;
    // deleting fails (e.g. missing permission), then the channel is deleted by hand
    const deleteChannel = t.ctx.server.deleteChannel.bind(t.ctx.server);
    (t.ctx.server as { deleteChannel: unknown }).deleteChannel = async () => {
      throw new Error("Missing Permissions");
    };
    await route(t, "POST /tickets/1/close", { viewer: "2" });
    (t.ctx.server as { deleteChannel: unknown }).deleteChannel = deleteChannel;
    expect(t.kv.get("ticket:00000001")).toMatchObject({ channelRemoved: false });
    gone(first);
    const createChannel = t.ctx.server.createChannel.bind(t.ctx.server);
    (t.ctx.server as { createChannel: unknown }).createChannel = async () => {
      throw new Error("Missing Permissions");
    };
    await expect(route(t, "POST /tickets/1/reopen", { viewer: "2" })).rejects.toThrow();
    expect(t.kv.get("ticket:00000001")).toMatchObject({ status: "closed" });
    expect(t.kv.has("open:1:1")).toBe(false);
    (t.ctx.server as { createChannel: unknown }).createChannel = createChannel;
    const res = await route(t, "POST /tickets/1/reopen", { viewer: "2" });
    expect(res.status).toBe(200);
    expect(t.createdChannels).toHaveLength(2);
    expect(res.body).toMatchObject({ channelId: t.createdChannels[1]!.channel.id });
  });

  test("a portal reply to a ticket whose channel is gone is a 409", async () => {
    const t = setup();
    await openTicket(t);
    gone(t.createdChannels[0]!.channel);
    const res = await route(t, "POST /tickets/1/messages", {
      viewer: "2",
      body: { content: "hello?" },
    });
    expect(res.status).toBe(409);
    expect(t.sent.filter((s) => s.to === t.createdChannels[0]!.channel.id)).toHaveLength(1);
  });
});
