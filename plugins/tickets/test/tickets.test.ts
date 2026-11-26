import en from "../locales/en.json" with { type: "json" };
import fr from "../locales/fr.json" with { type: "json" };
import type { Context, Json, Message, TextChannel } from "@cicord/sdk";
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
  "portal.links",
  "events.publish",
  "scheduler",
  "discord.dm.send",
  "discord.messages.manage",
  "discord.roles.assign",
];

// 1 alice, 3 eve: members. 2 sam, 4 max: staff role. 5 mona: Cicord moderator without the
// staff role. 6 ada: Cicord admin. 9 olga: server owner.
function setup(
  config: Record<string, unknown> = {},
  options: {
    features?: string[];
    plugins?: Context["plugins"];
    grants?: string[];
    locale?: string;
  } = {},
) {
  return createTestContext({
    locales: { en, fr },
    schema,
    config: {
      panelChannel: "help-desk",
      category: "support",
      staffRoles: ["support"],
      logChannel: "ticket-log",
      ...config,
    },
    grants,
    ...options,
    // As in plugin.yaml: GET /staff (role.members()) needs ServerMembers.
    intents: ["ServerMessages", "MessageContent", "ServerMembers"],
    plugin: { name: "tickets" },
    server: { id: "100", ownerId: "9", everyonePermissions: ["ViewChannel", "ReadMessageHistory"] },
    access: { admins: { users: ["6"] }, moderators: { roles: ["support", "mods"] } },
    roles: { support: { name: "Support" }, member: { name: "Member" }, mods: { name: "Mods" } },
    channels: {
      "help-desk": { name: "help-desk" },
      "ticket-log": { name: "ticket-log" },
      "private-log": {
        name: "private-log",
        overwrites: {
          "@everyone": { deny: ["ViewChannel"] },
          support: { allow: ["ViewChannel", "ReadMessageHistory"] },
        },
      },
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
      components: [
        { components: [{ id: "close:1", label: "Close" }] },
        { components: [{ id: "claim:1" }] },
      ],
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
      content: expect.stringContaining("Ticket #1 closed."),
    });
    expect(log?.message).not.toHaveProperty("files");
    expect(JSON.stringify(log?.message)).not.toContain("Since yesterday");
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

  test("the server owner can read and close legacy tickets", async () => {
    for (const user of ["9"]) {
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
      type: "default",
      labels: ["bug"],
      rating: null,
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
      components: [{ components: [{ id: "close:1" }] }, { components: [{ id: "claim:1" }] }],
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
    // A deleted source cannot authorize access to its captured participants or messages.
    expect((await route(t, "GET /tickets/1", { viewer: "2" })).status).toBe(404);
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
      locales: { en, fr },
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
    expect(log.message).toMatchObject({ content: expect.stringContaining("Ticket #1 closed.") });
    expect(log.message).not.toHaveProperty("files");
    expect(JSON.stringify(log.message)).not.toContain("Fixed in 0.1.5");
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
        components: [{ components: [{ id: "close:1" }] }, { components: [{ id: "claim:1" }] }],
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
    expect(post).toMatchObject({ id, to: channel.id, message: { content: en.relayPending } });
    expect(t.edits.find((e) => e.id === id)?.message).toMatchObject({
      embeds: [
        { description: "Restart it with @everyone <@1>", footer: { text: "— sam (via portal)" } },
      ],
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

describe("ticket types and modmail", () => {
  const typed = () =>
    setup({
      types: [
        {
          key: "help",
          name: "Help",
          staffRoles: ["support"],
          logChannel: "private-log",
          retainSourceForTranscript: true,
          fields: [{ label: "Order number", required: true }],
          defaultLabels: ["question"],
        },
        { key: "appeals", name: "Appeals", staffRoles: ["mods"], logChannel: "ticket-log" },
      ],
    });
  test("role and source access are enforced on every route and after revocation", async () => {
    const t = typed();
    expect((await portalOpen(t, "1", { type: "help" })).status).toBe(201);
    expect((await portalOpen(t, "3", { type: "appeals" })).status).toBe(201);
    const [a, b] = t.createdChannels;
    expect(t.member("2")!.canView(a!.channel)).toBe(true);
    expect(t.member("2")!.canView(b!.channel)).toBe(false);
    expect(t.member("5")!.canView(a!.channel)).toBe(false);
    expect(t.member("5")!.canView(b!.channel)).toBe(true);
    for (const [staff, own, other] of [
      ["2", "1", "2"],
      ["5", "2", "1"],
    ] as const) {
      expect((await route(t, "GET /tickets", { viewer: staff })).body).toMatchObject({
        items: [{ id: own }],
      });
      expect((await route(t, "GET /tickets/" + own, { viewer: staff })).status).toBe(200);
      for (const [path, body] of [
        ["GET /tickets/" + other, undefined],
        ["POST /tickets/" + other + "/notes", { content: "private" }],
        ["POST /tickets/" + other + "/assign", { userId: "me" }],
        ["GET /tickets/" + other + "/cases", undefined],
      ] as const)
        expect((await route(t, path, { viewer: staff, body })).status).toBe(404);
    }
    expect(
      (await route(t, "POST /tickets/1/assign", { viewer: "2", body: { userId: "5" } })).status,
    ).toBe(400);
    await route(t, "POST /tickets/1/notes", {
      viewer: "2",
      body: { content: "Only help staff can see me" },
    });
    expect(
      JSON.stringify((await route(t, "GET /tickets/mine/1", { viewer: "1" })).body),
    ).not.toContain("Only help");
    await route(t, "POST /tickets/1/close", { viewer: "2" });
    await route(t, "POST /tickets/2/close", { viewer: "5" });
    for (const [staff, member, own, other] of [
      ["2", "1", "1", "2"],
      ["5", "3", "2", "1"],
    ] as const) {
      for (const viewer of [staff, member])
        expect((await route(t, "GET /tickets/" + own + "/transcript", { viewer })).status).toBe(
          200,
        );
      expect(
        (await route(t, "GET /tickets/" + other + "/transcript", { viewer: staff })).status,
      ).toBe(404);
    }
    await t.member("2")!.setRoles([]);
    expect((await route(t, "GET /tickets/1/transcript", { viewer: "2" })).status).toBe(404);
    expect((await route(t, "GET /tickets/1", { viewer: "2" })).status).toBe(403);
    expect((await route(t, "GET /tickets/1/transcript", { viewer: "4" })).status).toBe(200);
    const narrow = t.sent.find((s) => s.to === "private-log");
    expect(t.edits.find((e) => e.id === narrow?.id)?.message).toMatchObject({
      files: [{ name: "ticket-1.html" }, { name: "ticket-1.md" }],
    });
    const wide = t.sent.find((s) => s.to === "ticket-log");
    expect(wide?.message).not.toHaveProperty("files");
    expect(JSON.stringify(wide?.message)).not.toContain("Bot is offline");
  });

  test("a 500-message transcript paginates, escapes HTML, and preserves each author's privacy", async () => {
    const t = typed();
    await portalOpen(t, "1", { type: "help", subject: "Private request" });
    const channel = t.createdChannels[0]!.channel;
    for (let n = 0; n < 500; n++) {
      const line = await channel.send(`row-${n} <script>alert(1)</script>`);
      Object.assign(line, {
        author: t.member(n % 2 ? "1" : "2")!.user,
        member: t.member(n % 2 ? "1" : "2"),
      });
    }
    await route(t, "POST /tickets/1/notes", { viewer: "2", body: { content: "Staff annotation" } });
    await route(t, "POST /tickets/1/close", { viewer: "2" });
    const res = await route(t, "GET /tickets/1/transcript", { viewer: "1" });
    const html = (res.body as { content: string }).content;
    expect(html).toContain("row-499 ");
    expect(html).toContain("row-0 ");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(new TextEncoder().encode(html).length).toBeLessThan(2 * 1024 * 1024);
    const ctx = {
      ...t.ctx,
      privacy: { ...t.ctx.privacy, pseudonym: async () => "deleted-user-abcdef0123456789" },
    };
    await plugin.privacy!.erase(ctx, "1");
    expect(await plugin.privacy!.export(ctx, "1")).toEqual([]);
    const kept = await route(t, "GET /tickets/1/transcript", { viewer: "2" });
    expect(JSON.stringify(kept.body)).toContain("row-498 ");
    expect(JSON.stringify(kept.body)).not.toContain("row-499 ");
    expect(JSON.stringify(await plugin.privacy!.export(ctx, "2"))).toContain("Staff annotation");
    expect(t.deletedMessages).toContainEqual(
      expect.objectContaining({ id: t.sent.find((s) => s.to === "private-log")!.id }),
    );
    expect(t.kv.has("author:1:00000001")).toBe(false);
  });

  test("a typed form, claim and bidirectional DM relay use the selected tenant", async () => {
    const t = typed();
    const click = await runComponent(plugin, t, "open:help", { user: "1", channel: "help-desk" });
    expect(click.modal?.fields).toContainEqual(
      expect.objectContaining({ label: "Order number", required: true }),
    );
    const dm = (user: string, content: string) => ({
      ...messageIn(t, t.channel("help-desk")!, user, content),
      content,
    });
    const started = Date.now();
    await plugin.events!.directMessage!(t.ctx, dm("1", "My request"));
    await plugin.events!.directMessage!(t.ctx, dm("1", "One more detail"));
    expect(t.createdChannels).toHaveLength(1);
    const channel = t.createdChannels[0]!.channel;
    expect(
      t.sent
        .filter((s) => s.to === channel.id)
        .map((s) => t.message(s.id)?.content)
        .join(" "),
    ).toContain("One more detail");
    const welcome = t.sent.find((s) => s.to === channel.id)!;
    await runComponent(plugin, t, "claim:1", { user: "2", message: t.message(welcome.id)! });
    expect(t.kv.get("ticket:00000001")).toMatchObject({ assignee: { id: "2" }, type: "help" });
    await plugin.events!.messageCreate!(t.ctx, { ...dm("5", "wrong staff"), channel });
    expect(t.sent.some((s) => s.to === "dm:1")).toBe(false);
    await plugin.events!.messageCreate!(t.ctx, { ...dm("2", "Staff response"), channel });
    expect(t.message(t.sent.find((s) => s.to === "dm:1")!.id)).toMatchObject({
      content: "Staff response",
    });
    expect(Date.now() - started).toBeLessThan(2000);
    await route(t, "POST /tickets/1/messages", { viewer: "2", body: { content: "Portal reply" } });
    expect(t.message(t.sent.filter((s) => s.to === "dm:1").at(-1)!.id)).toMatchObject({
      content: "Portal reply",
    });
  });

  test("stored inactivity warnings survive restart and always precede closure by an hour", async () => {
    const t = setup({ inactivityHours: 1, firstResponseMinutes: 1 });
    await portalOpen(t);
    const { maintenance } = await import("../src/lifecycle.ts");
    const original = t.kv.get("ticket:00000001") as Record<string, Json>;
    t.kv.set("ticket:00000001", {
      ...original,
      createdAt: new Date(Date.now() - 7200000).toISOString(),
    });
    await maintenance(t.ctx);
    const warned = t.kv.get("ticket:00000001") as Record<string, Json>;
    expect(warned.status).toBe("open");
    expect(warned.warningAt).toEqual(expect.any(Number));
    await maintenance(t.ctx);
    expect(t.sent.filter((m) => JSON.stringify(m.message).includes("one more hour")).length).toBe(
      1,
    );
    const resumed = setup({ inactivityHours: 1 });
    // Replace the session-local scheduler and plugin context; restore the persisted ticket state.
    await portalOpen(resumed);
    for (const [k, v] of t.kv) resumed.kv.set(k, v);
    resumed.kv.set("ticket:00000001", { ...warned, warningAt: Date.now() - 3601000 });
    await maintenance(resumed.ctx);
    await maintenance(resumed.ctx);
    expect(resumed.kv.get("ticket:00000001")).toMatchObject({ status: "closed" });
    expect(resumed.published.filter((e) => e.topic === "closed")).toHaveLength(1);
  });
});

test("concurrent opens share the limit, and action retries share the original ticket", async () => {
  const t = setup();
  const results = await Promise.all([portalOpen(t), portalOpen(t)]);
  expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
  expect(t.createdChannels).toHaveLength(1);
  const caller = {
    plugin: "moderation",
    bot: "bot",
    instance: "mod",
    source: "cicord",
    verified: true,
  };
  const call = {
    caller,
    onBehalfOf: {
      userId: "3",
      access: "scoped" as const,
      resourceScope: { kind: "case", id: "72" },
    },
    idempotencyKey: "appeal:72",
  };
  const data = { userId: "3", subject: "Appeal", caseNumber: 72 };
  const action = plugin.actions!.open!;
  const first = await action.run(t.ctx, data, call);
  expect(await action.run(t.ctx, data, call)).toEqual(first);
  expect(t.createdChannels).toHaveLength(1);
  expect(first).toEqual({ id: "2" });
  await plugin.tasks!.provision!(t.ctx, { number: 2 });
  await plugin.tasks!.provision!(t.ctx, { number: 2 });
  expect(t.createdChannels).toHaveLength(2);
  await expect(action.run(t.ctx, { ...data, caseNumber: 71 }, call)).rejects.toThrow("scope");
  expect(await plugin.queries!.openFor!.run(t.ctx, { userId: "3" }, call)).toEqual({ tickets: [] });
});

test("DM retraction removes the erased staff writer's relays and retains other staff messages", async () => {
  const t = setup();
  const dm = messageIn(t, t.channel("help-desk")!, "1");
  await plugin.events!.directMessage!(t.ctx, { ...dm, content: "Question" });
  const channel = t.createdChannels[0]!.channel;
  for (const [id, content] of [
    ["2", "Sam reply"],
    ["4", "Max reply"],
  ] as const)
    await plugin.events!.messageCreate!(t.ctx, {
      ...messageIn(t, channel, id, id + "message"),
      content,
    });
  const sent = t.sent.filter((m) => m.to === "dm:1");
  expect(sent).toHaveLength(2);
  const ctx = {
    ...t.ctx,
    privacy: { ...t.ctx.privacy, pseudonym: async () => "deleted-user-1234567812345678" },
  };
  await plugin.privacy!.erase(ctx, "2");
  expect(t.message(sent[0]!.id)).toBeUndefined();
  expect(t.message(sent[1]!.id)?.content).toBe("Max reply");
});

test("the first satisfaction vote is retained and statistics are staff-only", async () => {
  const t = setup();
  await portalOpen(t);
  await route(t, "POST /tickets/1/close", { viewer: "2" });
  expect(
    (await route(t, "POST /tickets/1/rating", { viewer: "3", body: { rating: 2 } })).status,
  ).toBe(404);
  expect(
    (await route(t, "POST /tickets/1/rating", { viewer: "1", body: { rating: 4 } })).status,
  ).toBe(200);
  expect(
    (await route(t, "POST /tickets/1/rating", { viewer: "1", body: { rating: 5 } })).body,
  ).toEqual({ rating: 4 });
  expect((await route(t, "GET /tickets/stats", { viewer: "2" })).body).toEqual({
    rated: 1,
    mean: 4,
  });
  expect((await route(t, "GET /tickets/stats", { viewer: "3" })).status).toBe(403);
  expect(t.published.filter((e) => e.topic === "rated")).toHaveLength(1);
});

test("SDK15 localizes the form and defaults and preserves operator-provided text", async () => {
  expect(Object.keys(fr).sort()).toEqual(Object.keys(en).sort());
  expect(fr["commands.ticket-panel.options.channel.name"]).toBe("salon");
  expect(fr["contextMenus.Open ticket on message.name"]).toBe("Ouvrir un ticket sur ce message");
  const t = setup({}, { locale: "fr" });
  const panel = await runCommand(plugin, t, "ticket-panel", { user: "2" });
  expect(panel.replies[0]).toContain("Panneau de tickets publié");
  expect(t.sent[0]?.message).toMatchObject({ embeds: [{ title: "Besoin d’aide ?" }] });
  const click = await runComponent(plugin, t, "open", { user: "1", locale: "fr" });
  expect(click.modal?.fields.map((f) => f.label)).toEqual(["Objet", "Détails"]);
  const custom = setup({
    locale: "fr",
    panel: { title: "Service Desk", buttonLabel: "Open IT", description: "Request IT help" },
    welcomeMessage: "Custom hello {member}!",
  });
  await runCommand(plugin, custom, "ticket-panel", { user: "2" });
  expect(custom.sent[0]!.message).toMatchObject({
    embeds: [{ title: "Service Desk", description: "Request IT help" }],
    components: [{ components: [{ label: "Open IT" }] }],
  });
  await portalOpen(custom);
  expect(custom.sent.at(-1)?.message).toMatchObject({ content: "Custom hello <@1>!" });
  const limited = setup({ locale: "fr" }, { locale: "en" });
  const form = await runComponent(plugin, limited, "open", { user: "1", locale: "en" });
  expect(form.modal?.title).toBe("Ouvrir un ticket");
});

test("optional interop uses only on-duty staff of the current type and filters moderation results", async () => {
  const calls: string[] = [];
  const providers = {
    has: () => true,
    hasFeature: () => true,
    call: async () => {
      throw new Error("Unexpected action");
    },
    query: async (plugin: string, method: string): Promise<Json> => {
      calls.push(plugin + "." + method);
      return method === "onDuty"
        ? { userIds: ["2", "5"] }
        : {
            cases: [
              {
                number: 7,
                action: "warn",
                status: "active",
                reason: "Reminder",
                at: "2026-01-01",
                privateField: "private",
              },
            ],
          };
    },
  } as Context["plugins"];
  const config = { types: [{ key: "help", name: "Help", staffRoles: ["support"] }] };
  const disabled = setup(config, { plugins: providers });
  await portalOpen(disabled);
  expect(calls).toEqual([]);
  expect((await route(disabled, "GET /tickets/1/cases", { viewer: "2" })).body).toEqual({
    cases: [],
  });
  const t = setup(config, {
    plugins: providers,
    features: ["onDuty", "caseContext"],
    grants: [...grants, "plugins.query:staff-shifts.onDuty", "plugins.query:moderation.cases"],
  });
  await portalOpen(t);
  expect(t.sent[0]?.message).toMatchObject({ content: expect.stringContaining("<@2>") });
  expect(JSON.stringify(t.sent[0]?.message)).not.toContain("<@5>");
  expect((await route(t, "GET /tickets/1/cases", { viewer: "3" })).status).toBe(404);
  const cases = await route(t, "GET /tickets/1/cases", { viewer: "2" });
  expect(cases.body).toEqual({
    cases: [{ number: 7, action: "warn", status: "active", reason: "Reminder", at: "2026-01-01" }],
  });
  expect(calls).toEqual(["staff-shifts.onDuty", "moderation.cases"]);
});

test("a stale staff update cannot restore erased ticket data from another invocation realm", async () => {
  const t = setup();
  await portalOpen(t, "1");
  const { getTicket, saveTicket } = await import("../src/tickets.ts");
  const stale = (await getTicket(t.ctx, 1))!;
  stale.notes.push({
    by: { id: "2", displayName: "Sam" },
    at: new Date().toISOString(),
    content: "Postponed staff edit",
  });
  let resume!: () => void;
  const suspended = new Promise<void>((r) => {
    resume = r;
  }).then(() => saveTicket(t.ctx, stale));
  const ctx = {
    ...t.ctx,
    privacy: { ...t.ctx.privacy, pseudonym: async () => "deleted-user-0000000000000001" },
  };
  await plugin.privacy!.erase(ctx, "1");
  resume();
  await expect(suspended).rejects.toThrow("Ticket changed");
  const persisted = (await getTicket(t.ctx, 1))!;
  expect(persisted.author.id).toBe("deleted-user-0000000000000001");
  expect(persisted.description).toBe("");
  expect(persisted.notes).toHaveLength(0);
});

test("lost acknowledgements leave a durable receipt; widened offline log ACLs withdraw files and a safe log recovers", async () => {
  const t = setup({
    types: [
      {
        key: "help",
        name: "Help",
        staffRoles: ["support"],
        logChannel: "private-log",
        retainSourceForTranscript: true,
      },
    ],
  });
  await portalOpen(t, "1", { type: "help" });
  const { getTicket, closeTicket } = await import("../src/tickets.ts");
  const { reconcileCopy } = await import("../src/transcript.ts");
  const original = t.ctx.server;
  let failShell = true,
    failEdit = true,
    wide = false;
  const log = original.channel("private-log");
  const server = {
    ...original,
    verifyReaders: async (
      ref: Parameters<typeof original.verifyReaders>[0],
      options: Parameters<typeof original.verifyReaders>[1],
    ) => {
      const report = await original.verifyReaders(ref, options);
      return wide ? { ...report, destination: "wider" as const } : report;
    },
    compareAudience: (
      src: Parameters<typeof original.compareAudience>[0],
      dest: Parameters<typeof original.compareAudience>[1],
    ) => (wide ? ("wider" as const) : original.compareAudience(src, dest)),
    channel: (ref: Parameters<typeof original.channel>[0]) => {
      const ch = original.channel(ref);
      if (ch.id !== log.id) return ch;
      return {
        ...ch,
        send: async (input: Parameters<typeof ch.send>[0]) => {
          const saved = await ch.send(input);
          if (failShell) {
            failShell = false;
            throw Error("Lost shell acknowledgement");
          }
          return saved;
        },
        message: async (id: string) => {
          const saved = await ch.message(id);
          if (!saved) return saved;
          return {
            ...saved,
            edit: async (input: Parameters<typeof saved.edit>[0]) => {
              const updated = await saved.edit(input);
              const receipt = (await getTicket(t.ctx, 1))!.logDelivery;
              expect(receipt).toMatchObject({ messageId: id, phase: "attaching" });
              if (failEdit) {
                failEdit = false;
                throw Error("Lost attachment acknowledgement");
              }
              return updated;
            },
          };
        },
      };
    },
  };
  const ctx = { ...t.ctx, server };
  await expect(
    closeTicket(ctx, (await getTicket(ctx, 1))!, { id: "2", displayName: "Sam" }),
  ).rejects.toThrow("Lost shell");
  const shells = () => t.sent.filter((s) => s.to === "private-log");
  expect(shells()).toHaveLength(1);
  expect(shells()[0]?.message).not.toHaveProperty("files");
  const first = shells()[0]!.id;
  // Recover the message even if Discord accepted the send before its ID reached KV.
  const pending = (await getTicket(ctx, 1))!;
  expect(pending.logDelivery).toMatchObject({ phase: "pending" });
  // Use the gated message lookup after the first shell is recovered.
  const actualEdit = t.message(first)!.edit;
  Object.assign(t.message(first)!, {
    edit: async (input: Parameters<typeof actualEdit>[0]) => {
      const edited = await actualEdit(input);
      const receipt = (await getTicket(ctx, 1))!.logDelivery;
      expect(receipt).toMatchObject({ phase: "attaching", messageId: first });
      if (failEdit) {
        failEdit = false;
        throw Error("Lost attachment acknowledgement");
      }
      return edited;
    },
  });
  await expect(reconcileCopy(ctx, pending)).rejects.toThrow("Lost attachment");
  expect(shells()).toHaveLength(1);
  expect(t.edits.find((e) => e.id === first)?.message).toHaveProperty("files");
  wide = true;
  await plugin.onStart!(ctx);
  expect(t.deletedMessages).toContainEqual(expect.objectContaining({ id: first }));
  const fallback = (await getTicket(ctx, 1))!.logDelivery!;
  expect(fallback.phase).toBe("summary");
  expect(shells()).toHaveLength(2);
  expect(shells()[1]?.message).not.toHaveProperty("files");
  wide = false;
  await plugin.events!.serverAvailable!(ctx);
  expect((await getTicket(ctx, 1))!.logDelivery?.phase).toBe("attached");
  expect(t.edits.some((e) => e.id === fallback.messageId)).toBe(true);
  // Change the source ACL while offline. A now-readable destination cannot legitimize it.
  await ctx.server.editChannel(
    { id: t.createdChannels[0]!.channel.id },
    { overwrites: { "@everyone": { allow: ["ViewChannel", "ReadMessageHistory"] } } },
  );
  await plugin.schedules!.maintenance!.run(ctx);
  expect((await getTicket(ctx, 1))!.logDelivery?.phase).toBe("summary");
});

test("unverifiable or deleted sources never receive a file-bearing log post", async () => {
  const t = setup({
    types: [
      {
        key: "help",
        name: "Help",
        staffRoles: ["support"],
        logChannel: "private-log",
        retainSourceForTranscript: false,
      },
    ],
  });
  await portalOpen(t);
  await route(t, "POST /tickets/1/close", { viewer: "2" });
  const log = t.sent.find((s) => s.to === "private-log")!;
  expect(log.message).not.toHaveProperty("files");
  expect(t.edits.some((e) => e.id === log.id)).toBe(false);
});

test("combined role overrides, NSFW and deleted channels cannot be authorized by a stored reader summary", async () => {
  const t = setup({
    types: [
      { key: "help", name: "Help", staffRoles: ["support"], retainSourceForTranscript: true },
    ],
  });
  await portalOpen(t);
  const ch = t.createdChannels[0]!.channel;
  await t.ctx.server.editChannel(ch, {
    overwrites: {
      support: { clear: ["ReadMessageHistory"] },
      mods: { deny: ["ReadMessageHistory"] },
    },
  });
  await route(t, "POST /tickets/1/close", { viewer: "2" });
  const routeKey = "GET /tickets/1/transcript";
  expect((await route(t, routeKey, { viewer: "2" })).status).toBe(200);
  await t.member("2")!.addRole("mods");
  expect((await route(t, routeKey, { viewer: "2" })).status).toBe(404);
  await t.ctx.server.deleteChannel(ch);
  expect((await route(t, routeKey, { viewer: "4" })).status).toBe(404);

  const gated = createTestContext({
    locales: { en, fr },
    schema,
    config: { panelChannel: "gated", staffRoles: ["support"] },
    server: { id: "100", ownerId: "9", everyonePermissions: ["ViewChannel", "ReadMessageHistory"] },
    roles: { support: { name: "Support" } },
    members: [{ id: "9", username: "owner" }],
    channels: {
      gated: {
        name: "gated",
        nsfw: true,
        overwrites: {
          "@everyone": { deny: ["ViewChannel"] },
          "member:9": { allow: ["ViewChannel", "ReadMessageHistory"] },
        },
      },
    },
  });
  const { mayReadTranscript, getTicket } = await import("../src/tickets.ts");
  const ticket = (await getTicket(t.ctx, 1))!;
  const source = gated.channel("gated")!;
  const historical = {
    ...ticket,
    type: "default",
    author: { id: "9", displayName: "owner" },
    channelRemoved: false,
    channelId: source.id,
    archivePolicy: gated.ctx.server.audience(source).fingerprint,
  };
  expect(await mayReadTranscript(gated.ctx, historical, gated.member("9"))).toBe(false);
});

test("incoming DM text and attachments are withheld after an extra member gains access", async () => {
  const t = setup({ types: [{ key: "help", name: "Help", staffRoles: ["support"] }] });
  const member = t.member("1")!;
  const original = { ...messageIn(t, t.channel("help-desk")!, "1"), content: "Original" };
  await plugin.events!.directMessage!(t.ctx, original);
  const ch = t.createdChannels[0]!.channel;
  await t.ctx.server.editChannel(ch, {
    overwrites: { "member:3": { allow: ["ViewChannel", "ReadMessageHistory"] } },
  });
  expect(t.member("3")!.canView(ch)).toBe(true);
  const sensitive = "https://cdn.discordapp.com/attachments/private/file.png";
  await plugin.events!.directMessage!(t.ctx, {
    ...original,
    id: "new-private-dm",
    content: "Private follow-up",
    member,
    attachments: [{ filename: "private.png", url: sensitive }] as unknown as Message["attachments"],
  });
  const posts = t.sent.filter((s) => s.to === ch.id);
  expect(JSON.stringify(posts)).not.toContain("Private follow-up");
  expect(JSON.stringify(posts)).not.toContain(sensitive);
  expect(t.sent.at(-1)).toMatchObject({ to: "dm:1", message: en.relayDenied });
});

test("outbound modmail rechecks each recipient's channel history access, including portal replies", async () => {
  const t = setup({ types: [{ key: "help", name: "Help", staffRoles: ["support"] }] });
  for (const id of ["1", "3"])
    await plugin.events!.directMessage!(t.ctx, {
      ...messageIn(t, t.channel("help-desk")!, id),
      content: "Open private conversation",
    });
  const first = t.createdChannels[0]!.channel,
    second = t.createdChannels[1]!.channel;
  await plugin.events!.messageCreate!(t.ctx, {
    ...messageIn(t, first, "2"),
    content: "First staff message",
  });
  expect(t.sent.filter((m) => m.to === "dm:1")).toHaveLength(1);
  await t.ctx.server.editChannel(first, {
    overwrites: { "member:1": { deny: ["ReadMessageHistory"] } },
  });
  expect(t.member("1")!.canView(first)).toBe(false);
  const attachment = "https://cdn.discordapp.com/attachments/private-document";
  const docs = [
    { filename: "private-document", url: attachment },
  ] as unknown as Message["attachments"];
  await plugin.events!.messageCreate!(t.ctx, {
    ...messageIn(t, first, "2", "revoked"),
    content: "Revoked staff message",
    attachments: docs,
  });
  expect(t.sent.filter((m) => m.to === "dm:1")).toHaveLength(1);
  expect(
    (
      await route(t, "POST /tickets/1/messages", {
        viewer: "2",
        body: { content: "Private portal content" },
      })
    ).status,
  ).toBe(403);
  expect(JSON.stringify(t.sent)).not.toContain("Private portal content");
  await plugin.events!.messageCreate!(t.ctx, {
    ...messageIn(t, second, "2"),
    content: "Unchanged recipient",
    attachments: docs,
  });
  expect(t.message(t.sent.filter((m) => m.to === "dm:3").at(-1)!.id)).toMatchObject({
    content: "Unchanged recipient\n" + attachment,
  });
});

test("a lost private relay edit in either direction keeps its receipt through erasure", async () => {
  const t = setup();
  const open = {
    ...messageIn(t, t.channel("help-desk")!, "1", "initial"),
    content: "First private DM",
  };
  await plugin.events!.directMessage!(t.ctx, open);
  const channel = t.createdChannels[0]!.channel;
  const { getTicket } = await import("../src/tickets.ts");
  const { relay, pendingRelays } = await import("../src/relay.ts");
  const { privacy } = await import("../src/privacy.ts");
  const base = t.ctx.server;
  const injected = {
    ...t.ctx,
    server: {
      ...base,
      channel: (ref: Parameters<typeof base.channel>[0]) => {
        const original = base.channel(ref);
        if (original.id !== channel.id) return original;
        return {
          ...original,
          message: async (id: string) => {
            const m = await original.message(id);
            if (!m) return m;
            return {
              ...m,
              edit: async (input: Parameters<typeof m.edit>[0]) => {
                await m.edit(input);
                throw Error("Lost channel edit acknowledgement");
              },
            };
          },
        };
      },
      editRetractableDM: async (
        id: string,
        input: Parameters<typeof base.editRetractableDM>[1],
      ) => {
        await base.editRetractableDM(id, input);
        throw Error("Lost DM edit acknowledgement");
      },
    },
  };
  const ticket = (await getTicket(t.ctx, 1))!;
  expect(ticket.description).toBe("");
  await expect(
    relay(
      injected,
      ticket,
      "inbound",
      { id: "1", displayName: "Alice" },
      "Inbound confidential text",
      "in-2",
      new Date(),
    ),
  ).rejects.toThrow("Lost channel");
  await expect(
    relay(
      injected,
      ticket,
      "outbound",
      { id: "2", displayName: "Sam" },
      "Outbound confidential text",
      "out-2",
      new Date(),
    ),
  ).rejects.toThrow("Lost DM");
  const receipts = (await pendingRelays(t.ctx, 1)).map((j) => j.targets[0]!.id!);
  expect(receipts).toHaveLength(2);
  expect(receipts.map((id) => t.message(id)!.content).sort()).toEqual([
    "Inbound confidential text",
    "Outbound confidential text",
  ]);
  expect(t.sent.every((s) => !JSON.stringify(s.message).includes("confidential text"))).toBe(true);
  const eraseCtx = {
    ...t.ctx,
    privacy: { ...t.ctx.privacy, pseudonym: async () => "deleted-user-0123456789abcdef" },
  };
  await privacy.erase(eraseCtx, "1");
  expect(await pendingRelays(t.ctx, 1)).toEqual([]);
  for (const id of receipts) expect(t.message(id)).toBeUndefined();
  expect(JSON.stringify([...t.kv.values()])).not.toContain("confidential text");
});

test("a pending outbound private edit cannot recreate the erased recipient's message", async () => {
  const t = setup();
  await plugin.events!.directMessage!(t.ctx, {
    ...messageIn(t, t.channel("help-desk")!, "1", "open"),
    content: "Initial",
  });
  const { getTicket } = await import("../src/tickets.ts");
  const { relay, pendingRelays } = await import("../src/relay.ts");
  const { privacy } = await import("../src/privacy.ts");
  let confirmed!: () => void, unblock!: () => void;
  const ready = new Promise<void>((r) => {
      confirmed = r;
    }),
    paused = new Promise<void>((r) => {
      unblock = r;
    });
  const ctx = {
    ...t.ctx,
    server: {
      ...t.ctx.server,
      async editRetractableDM(
        id: string,
        msg: Parameters<typeof t.ctx.server.editRetractableDM>[1],
      ) {
        confirmed();
        await paused;
        await t.ctx.server.editRetractableDM(id, msg);
      },
    },
  };
  const underway = relay(
    ctx,
    (await getTicket(t.ctx, 1))!,
    "outbound",
    { id: "2", displayName: "Sam" },
    "Delayed private reply",
    "src-delayed",
    new Date(),
  );
  await ready;
  const receipt = (await pendingRelays(t.ctx, 1))[0]!.targets[0]!.id!;
  expect(t.message(receipt)?.content).toBe(en.relayPending);
  await privacy.erase(
    {
      ...t.ctx,
      privacy: { ...t.ctx.privacy, pseudonym: async () => "deleted-user-0123456789abcdef" },
    },
    "1",
  );
  unblock();
  await expect(underway).rejects.toThrow();
  expect(t.message(receipt)).toBeUndefined();
  expect(await pendingRelays(t.ctx, 1)).toEqual([]);
});

test("both modmail detail routes withhold legacy initial text and URLs after source revocation or deletion", async () => {
  const t = setup({ types: [{ key: "help", name: "Help", staffRoles: ["support"] }] });
  const initial = "Confidential https://cdn.discordapp.com/attachments/private/original.png";
  await plugin.events!.directMessage!(t.ctx, {
    ...messageIn(t, t.channel("help-desk")!, "1", "original"),
    content: initial,
  });
  const raw = t.kv.get("ticket:00000001") as Record<string, Json>;
  expect(raw.description).toBe("");
  expect(raw.subject).not.toContain("Confidential");
  t.kv.set("ticket:00000001", { ...raw, description: initial });
  const channel = t.createdChannels[0]!.channel;
  await t.ctx.server.editChannel(channel, {
    overwrites: { "member:3": { allow: ["ViewChannel", "ReadMessageHistory"] } },
  });
  for (const [path, viewer] of [
    ["GET /tickets/mine/1", "1"],
    ["GET /tickets/1", "2"],
  ] as const) {
    const result = await route(t, path, { viewer });
    expect(result.status).toBe(404);
    expect(JSON.stringify(result.body)).not.toContain(initial);
  }
  await t.ctx.server.deleteChannel(channel);
  for (const [path, viewer] of [
    ["GET /tickets/mine/1", "1"],
    ["GET /tickets/1", "2"],
  ] as const) {
    const result = await route(t, path, { viewer });
    expect(result.status).toBe(404);
    expect(JSON.stringify(result.body)).not.toContain(initial);
  }
});

test("a committed interop ticket recovers the already-owned channel after losing its creation acknowledgement", async () => {
  const t = setup();
  const call = {
    caller: { plugin: "moderation", bot: "bot", instance: "mod", source: "local", verified: false },
    onBehalfOf: { userId: "1", access: "member" as const },
    idempotencyKey: "recover",
  };
  const out = await plugin.actions!.open!.run(
    t.ctx,
    { userId: "1", subject: "Provision once" },
    call,
  );
  expect(out).toEqual({ id: "1" });
  expect(t.createdChannels).toHaveLength(0);
  const grant = t.ctx.server.createChannel;
  const lost = {
    ...t.ctx,
    server: {
      ...t.ctx.server,
      async createChannel(opts: Parameters<typeof grant>[0]) {
        await grant(opts);
        throw Error("Lost creation acknowledgement");
      },
    },
  };
  await expect(plugin.tasks!.provision!(lost, { number: 1 })).rejects.toThrow(
    "Lost creation acknowledgement",
  );
  expect(t.createdChannels).toHaveLength(1);
  const { getTicket, saveTicket } = await import("../src/tickets.ts");
  const record = (await getTicket(t.ctx, 1))!;
  expect(record.channelId).toBe("");
  expect(record.provision?.phase).toBe("creating");
  record.provision!.since = Date.now() - 180000;
  await saveTicket(t.ctx, record);
  await plugin.tasks!.provision!(t.ctx, { number: 1 });
  await plugin.tasks!.provision!(t.ctx, { number: 1 });
  expect(t.createdChannels).toHaveLength(1);
  expect((await getTicket(t.ctx, 1))!.channelId).toBe(t.createdChannels[0]!.channel.id);
  expect(t.published.filter((e) => e.topic === "opened")).toHaveLength(1);
});
