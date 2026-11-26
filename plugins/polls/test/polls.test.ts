import type { Message, MessagePayload } from "@cicord/sdk";
import {
  callRoute,
  createTestContext,
  runAutocomplete,
  runCommand,
  runComponent,
} from "@cicord/sdk/testing";
import { describe, expect, test } from "vite-plus/test";
import en from "../locales/en.json" with { type: "json" };
import fr from "../locales/fr.json" with { type: "json" };
import schema from "../config.schema.json" with { type: "json" };
import plugin from "../src/index.ts";
import { parseChoices, suggestPolls, type Poll } from "../src/polls.ts";

const grants = [
  "discord.messages.send",
  "discord.messages.read",
  "discord.channels.read",
  "discord.threads.manage",
  "storage.kv",
  "scheduler",
  "events.publish",
  "portal.routes",
];

function setup(config: Record<string, unknown> = {}) {
  return createTestContext({
    locales: { en, fr },
    schema,
    config: { managerRoles: ["mod"], ...config },
    grants,
    plugin: { name: "polls" },
    server: { id: "server-1", everyonePermissions: ["ViewChannel", "ReadMessageHistory"] },
    roles: {
      mod: { name: "Moderator" },
      events: { name: "Events", mentionable: true },
      staff: { name: "Staff" },
      admins: { name: "Admins", permissions: ["Administrator"] },
      managers: { name: "Server managers", permissions: ["ManageServer"] },
    },
    channels: { polls: { name: "polls" }, general: { name: "general" } },
    members: [
      { id: "1", username: "alice" },
      { id: "2", username: "bob" },
      { id: "3", username: "mia", roles: ["mod"] },
      { id: "4", username: "ada", roles: ["admins"] },
      { id: "5", username: "sam", roles: ["managers"] },
    ],
  });
}

type Harness = ReturnType<typeof setup>;

async function start(t: Harness, options: Record<string, unknown> = {}) {
  const r = await runCommand(plugin, t, "poll", {
    user: "1",
    channel: "polls",
    options: { question: "Pizza night?", choices: "Friday | Saturday | Sunday", ...options },
  });
  const posted = t.sent.at(-1)!;
  return { r, message: t.message(posted.id) as Message, payload: posted.message as MessagePayload };
}

const description = (m: unknown): string => (m as MessagePayload).embeds?.[0]?.description ?? "";

describe("/poll", () => {
  test("posts the poll with vote buttons and schedules its closing", async () => {
    const t = setup();
    const { r, payload } = await start(t, { hours: 2 });
    expect(r.replies).toEqual(["Poll #1 posted. It closes in 2 h."]);
    expect(payload.embeds?.[0]?.title).toBe("📊 Pizza night?");
    expect(payload.components?.[0]?.components.map((c) => ("id" in c ? c.id : ""))).toEqual([
      "vote:1:0",
      "vote:1:1",
      "vote:1:2",
    ]);
    expect(payload.components?.[1]?.components[0]).toMatchObject({ id: "end:1" });
    expect(t.scheduled).toEqual([
      { id: "task-1", delayMs: 7_200_000, task: "close", payload: { id: "1" } },
    ]);
  });

  test("validates choices, uses the default duration, pings and opens a thread", async () => {
    const t = setup();
    const bad = await runCommand(plugin, t, "poll", {
      user: "1",
      channel: "polls",
      options: { question: "?", choices: "only one" },
    });
    expect(bad.replies[0]).toContain("2 to 10 different choices");
    const { payload } = await start(t, { thread: true, ping: t.ctx.server.role("events") });
    expect(payload.content).toBe("<@&role-events> — new poll by <@1>");
    expect(payload.allowedMentions).toEqual({ users: [], roles: ["role-events"], everyone: false });
    expect(t.scheduled[0]?.delayMs).toBe(24 * 3_600_000);
    expect(t.threads).toEqual([
      {
        parent: "channel-polls",
        name: "Poll: Pizza night?",
        private: false,
        fromMessage: t.sent[0]!.id,
      },
    ]);
  });

  test("ping: anyone may ping a member or a mentionable role, only managers other roles", async () => {
    const poll = (t: Harness, user: string, ping: unknown) =>
      runCommand(plugin, t, "poll", {
        user,
        channel: "polls",
        options: { question: "Q?", choices: "a | b", ping },
      });
    const t = setup();
    const staff = t.ctx.server.role("staff");

    // A non-manager cannot ping a role that is not mentionable (nor @everyone): nothing is posted.
    const refused = await poll(t, "1", staff);
    expect(refused.replies).toEqual([
      {
        content:
          "You cannot ping the role @Staff: only poll managers may ping a role that is not mentionable.",
        ephemeral: true,
      },
    ]);
    const everyone = { id: "server-1", name: "@everyone", mention: "@everyone", position: 0 };
    expect((await poll(t, "1", everyone)).replies[0]).toMatchObject({ ephemeral: true });
    expect(t.sent).toEqual([]);
    expect(t.scheduled).toEqual([]);

    // A member ping notifies that member only.
    await poll(t, "1", t.member("2")!.user);
    expect(t.sent.at(-1)?.allowedMentions).toEqual({ users: ["2"], roles: [], everyone: false });

    // Managers (managerRoles, Administrator, ManageServer) may ping any role: exactly that one.
    for (const manager of ["3", "4", "5"]) {
      const r = await poll(t, manager, staff);
      expect(r.replies[0]).toMatch(/^Poll #\d+ posted/);
      expect(t.sent.at(-1)?.allowedMentions).toEqual({
        users: [],
        roles: ["role-staff"],
        everyone: false,
      });
    }
    // @everyone by a manager: shown, never notified (as before).
    await poll(t, "3", everyone);
    expect(t.sent.at(-1)?.allowedMentions).toEqual({ users: [], roles: [], everyone: false });

    // Without a ping, the poll notifies nobody.
    await poll(t, "2", undefined);
    expect(t.sent.at(-1)?.allowedMentions).toEqual({ users: [], roles: [], everyone: false });
  });

  test("can be limited to some channels", async () => {
    const t = setup({ channels: ["polls"] });
    const r = await runCommand(plugin, t, "poll", {
      user: "1",
      channel: "general",
      options: { question: "?", choices: "a|b" },
    });
    expect(r.replies).toEqual(["Polls can be started in <#channel-polls>."]);
    expect(t.sent).toEqual([]);
  });
});

describe("voting", () => {
  test("buttons: one choice, toggled, live update and private confirmation", async () => {
    const t = setup();
    const { message } = await start(t);
    let r = await runComponent(plugin, t, "vote:1:1", { user: "2", message });
    expect(description(r.updates[0])).toContain("**2. Saturday**\n`████████████` 1 vote (100%)");
    expect(r.followUps).toEqual([{ content: "Your vote: **Saturday**", ephemeral: true }]);
    r = await runComponent(plugin, t, "vote:1:0", { user: "2", message });
    expect(t.kv.get("vote:1:2")).toEqual([0]);
    r = await runComponent(plugin, t, "vote:1:0", { user: "2", message });
    expect(r.followUps).toEqual([{ content: "Your vote was removed.", ephemeral: true }]);
    expect(t.kv.has("vote:1:2")).toBe(false);
  });

  test("select menu with several choices", async () => {
    const t = setup({ confirmVotes: false });
    const { message, payload } = await start(t, { style: "select", multiple: true });
    expect(payload.components?.[0]?.components[0]).toMatchObject({
      type: "select",
      id: "pick:1",
      maxValues: 3,
    });
    const r = await runComponent(plugin, t, "pick:1", {
      user: "2",
      message,
      values: ["2", "0", "9"],
    });
    expect(t.kv.get("vote:1:2")).toEqual([0, 2]);
    expect(r.followUps).toEqual([]);
    expect(description(r.updates[0])).toContain("**3. Sunday**\n`██████░░░░░░` 1 vote (50%)");
  });
});

describe("closing", () => {
  test("by the author: cancels the scheduled task, final results, publishes polls.closed", async () => {
    const t = setup();
    const { message } = await start(t);
    await runComponent(plugin, t, "vote:1:2", { user: "2", message });
    await runComponent(plugin, t, "vote:1:2", { user: "3", message });
    await runComponent(plugin, t, "vote:1:0", { user: "1", message });

    const denied = await runComponent(plugin, t, "end:1", { user: "2", message });
    expect(denied.replies).toEqual([
      { content: "Only the author of the poll can close it.", ephemeral: true },
    ]);

    const r = await runComponent(plugin, t, "end:1", { user: "1", message });
    expect(t.scheduled).toEqual([]);
    expect(r.updates[0]).toMatchObject({ components: [] });
    expect(description(r.updates[0])).toContain("**3. Sunday** 🏆");
    expect(t.published.slice(0, 1)).toMatchObject([
      {
        topic: "closed",
        payload: expect.objectContaining({
          pollId: "1",
          winners: ["Sunday"],
          voters: expect.arrayContaining(["1", "2", "3"]),
          closedBy: "1",
          choices: [
            { label: "Friday", votes: 1 },
            { label: "Saturday", votes: 0 },
            { label: "Sunday", votes: 2 },
          ],
        }),
      },
    ]);
    // a late vote only refreshes the closed poll
    const late = await runComponent(plugin, t, "vote:1:0", { user: "2", message });
    expect(late.updates[0]).toMatchObject({ components: [] });
    expect(t.kv.get("vote:1:2")).toEqual([2]);
  });

  test("a manager may close any poll", async () => {
    const t = setup();
    const { message } = await start(t);
    const r = await runComponent(plugin, t, "end:1", { user: "3", message });
    expect(r.updates).toHaveLength(1);
  });

  test("the scheduled task closes the poll and edits its message", async () => {
    const t = setup();
    const { message } = await start(t);
    await runComponent(plugin, t, "vote:1:1", { user: "2", message });
    await t.channel("polls")!.send("a newer message"); // the poll is no longer the newest
    await plugin.tasks!.close!(t.ctx, { id: "1" });
    expect(t.edits).toHaveLength(1);
    expect(t.edits[0]?.id).toBe(message.id);
    expect(t.published[0]?.payload).toMatchObject({ closedBy: null, winners: ["Saturday"] });
    // running it twice is harmless
    await plugin.tasks!.close!(t.ctx, { id: "1" });
    expect(t.published).toHaveLength(2);
  });
});

test("GET /polls/:id is public", async () => {
  const t = setup();
  const { message } = await start(t);
  await runComponent(plugin, t, "vote:1:0", { user: "2", message });
  const res = await callRoute(plugin, t, "GET /polls/1");
  expect(res).toMatchObject({
    status: 200,
    body: { id: "1", status: "open", voters: 1, choices: [{ label: "Friday", votes: 1 }, {}, {}] },
  });
  expect((await callRoute(plugin, t, "GET /polls/2")).status).toBe(404);
});

describe("/polls (subcommands with autocomplete)", () => {
  test("close: suggests the open polls of the member, then closes the picked one", async () => {
    const t = setup();
    const { message } = await start(t); // #1 by alice
    await start(t, { question: "Movie night?" }); // #2 by alice
    await runCommand(plugin, t, "poll", {
      user: "2",
      channel: "polls",
      options: { question: "Bob's poll", choices: "x | y" },
    }); // #3 by bob

    // alice only sees her polls; the typed text filters by number or question
    expect(await runAutocomplete(plugin, t, "polls close", { user: "1", focused: "poll" })).toEqual(
      [
        { name: "#2 Movie night?", value: "2" },
        { name: "#1 Pizza night?", value: "1" },
      ],
    );
    expect(
      await runAutocomplete(plugin, t, "polls close", {
        user: "1",
        focused: "poll",
        value: "pizza",
      }),
    ).toEqual([{ name: "#1 Pizza night?", value: "1" }]);
    // a manager sees every open poll
    expect(
      await runAutocomplete(plugin, t, "polls close", { user: "3", focused: "poll" }),
    ).toHaveLength(3);

    const denied = await runCommand(plugin, t, "polls close", {
      user: "2",
      options: { poll: "1" },
    });
    expect(denied.replies).toEqual(["Only the author of the poll can close it."]);

    const r = await runCommand(plugin, t, "polls close", {
      user: "1",
      options: { poll: "#1 Pizza night?" },
    });
    expect(r.replies).toEqual(["Poll #1 is closed."]);
    expect(t.edits.at(-1)?.id).toBe(message.id); // the poll message shows the final results
    expect(t.published[0]?.payload).toMatchObject({ pollId: "1", closedBy: "1" });
    // closed polls are no longer suggested for closing, but still for results
    expect(await runAutocomplete(plugin, t, "polls close", { user: "1", focused: "poll" })).toEqual(
      [{ name: "#2 Movie night?", value: "2" }],
    );
    expect(
      await runAutocomplete(plugin, t, "polls results", {
        user: "2",
        focused: "poll",
        value: "#1",
      }),
    ).toEqual([{ name: "#1 Pizza night?", value: "1" }]);
    expect(
      (await runCommand(plugin, t, "polls close", { user: "1", options: { poll: "1" } })).replies,
    ).toEqual(["Poll #1 is already closed."]);
  });

  test("results: an ephemeral embed with the current tally", async () => {
    const t = setup();
    const { message } = await start(t);
    await runComponent(plugin, t, "vote:1:2", { user: "2", message });
    const r = await runCommand(plugin, t, "polls results", { user: "2", options: { poll: "1" } });
    expect(description(r.replies[0])).toContain("**3. Sunday**\n`████████████` 1 vote (100%)");
    expect((r.replies[0] as MessagePayload).components).toBeUndefined();
    expect(
      (await runCommand(plugin, t, "polls results", { user: "2", options: { poll: "9" } })).replies,
    ).toEqual(["No such poll."]);
  });
});

test("helpers", () => {
  expect(parseChoices(" a | b ;a\nc ||")).toEqual(["a", "b", "c"]);
  const polls = Array.from(
    { length: 30 },
    (_, i) => ({ id: String(i + 1), question: "Topic" }) as Poll,
  );
  expect(suggestPolls(polls, "")).toHaveLength(25);
  expect(suggestPolls(polls, "#3")).toEqual([
    { name: "#3 Topic", value: "3" },
    { name: "#30 Topic", value: "30" },
  ]);
  expect(suggestPolls([{ id: "1", question: "x".repeat(200) } as Poll], "")[0]?.name).toHaveLength(
    100,
  );
});

test("weights, eligibility and anonymous erasure cover events, portal and delegated queries", async () => {
  const t = setup({ eligibleRoles: ["mod"], roleWeights: [{ role: "mod", weight: 3 }] });
  const { message } = await start(t, { anonymous: true });
  const refused = await runComponent(plugin, t, "vote:1:0", { user: "2", message });
  expect(refused.replies[0]).toMatchObject({ content: "Voting requires an eligible role." });
  await runComponent(plugin, t, "vote:1:1", { user: "3", message });
  await plugin.tasks!.close!(t.ctx, { id: "1" });
  expect(t.published[1]?.payload).toMatchObject({
    choices: [{ votes: 0 }, { votes: 3 }, { votes: 0 }],
    voters: [],
    voterCount: 1,
  });
  expect(t.kv.has("vote:1:3")).toBe(false);
  expect(await plugin.queries!.voters!.run(t.ctx, { pollId: "1" }, caller)).toEqual({
    userIds: [],
  });
  expect((await callRoute(plugin, t, "GET /polls/1")).body).toMatchObject({
    voters: 1,
    choices: [{ votes: 0 }, { votes: 3 }, { votes: 0 }],
  });
});
const caller = {
  caller: { bot: "main", instance: "levels", plugin: "levels", source: "cicord", verified: true },
};
test.each([4000, 10001])("complete voter pages and bounded v2 for %d participants", async (n) => {
  const t = setup();
  await start(t);
  for (let i = 0; i < n; i++) t.kv.set("vote:1:" + String(100000 + i), [0]);
  await plugin.tasks!.close!(t.ctx, { id: "1" });
  const payload = t.published[1]!.payload as {
    voterCount: number;
    voters?: string[];
    votersTruncated?: boolean;
  };
  expect(payload.voterCount).toBe(n);
  if (n > 10000) {
    expect(payload.voters).toBeUndefined();
    expect(payload.votersTruncated).toBe(true);
  } else expect(payload.voters).toHaveLength(n);
  const all = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = (await plugin.queries!.voters!.run(t.ctx, { pollId: "1", cursor }, caller)) as {
      userIds: string[];
      cursor?: string;
    };
    expect(page.userIds.length).toBeLessThanOrEqual(1000);
    for (const id of page.userIds) all.add(id);
    cursor = page.cursor;
  } while (cursor);
  expect(all.size).toBe(n);
  await plugin.tasks!.close!(t.ctx, { id: "1" });
  expect(t.published).toHaveLength(2);
});
test("native mode refuses incompatible options and publishes the Discord tally", async () => {
  for (const opt of [{ hours: 0.5 }, { anonymous: true }, { maximum: 1 }]) {
    const t = setup();
    const result = await runCommand(plugin, t, "poll", {
      user: "1",
      channel: "polls",
      options: { question: "Q", choices: "A|B", style: "native", ...opt },
    });
    expect(result.replies[0]).toContain("Native polls");
    expect(t.sent).toHaveLength(0);
  }
  const t = setup();
  const { message, payload } = await start(t, { style: "native", multiple: true });
  expect(payload.poll?.multiselect).toBe(true);
  t.votePoll(message.id, 2, "2");
  t.votePoll(message.id, 2, "3");
  t.votePoll(message.id, 3, "3");
  await plugin.tasks!.close!(t.ctx, { id: "1" });
  expect(t.published[1]?.payload).toMatchObject({
    voterCount: 2,
    voters: ["2", "3"],
    choices: [{ votes: 0 }, { votes: 2 }, { votes: 1 }],
  });
});

test("delegated voter queries and the public results route recheck source visibility", async () => {
  const h = setup();
  await start(h);
  await plugin.tasks!.close!(h.ctx, { id: "1" });
  const denied = { ...caller, onBehalfOf: { userId: "unavailable", access: "admin" as const } };
  await expect(plugin.queries!.voters!.run(h.ctx, { pollId: "1" }, denied)).rejects.toThrow();
  h.ctx.server.audience = () => ({
    known: true,
    public: false,
    allowRoles: [],
    allowMembers: [],
    denyMembers: [],
  });
  expect((await callRoute(plugin, h, "GET /polls/1")).status).toBe(404);
});
test("a scheduled poll opens once on task replay", async () => {
  const h = setup();
  const at = new Date(Date.now() + 3600000).toISOString();
  await runCommand(plugin, h, "poll", {
    user: "1",
    channel: "polls",
    options: { start: at, choices: "a|b", question: "When?" },
  });
  expect(h.sent).toHaveLength(0);
  await plugin.tasks!.open!(h.ctx, { id: "1" });
  await plugin.tasks!.open!(h.ctx, { id: "1" });
  expect(h.sent).toHaveLength(1);
});

test("anonymous manual closure hides the operator and voter identities in both versions", async () => {
  const h = setup();
  const { message } = await start(h, { anonymous: true });
  await runComponent(plugin, h, "vote:1:0", { user: "1", message });
  await runComponent(plugin, h, "end:1", { user: "1", message });
  for (const event of h.published)
    expect(event.payload).toMatchObject({ closedBy: null, voters: [] });
});
