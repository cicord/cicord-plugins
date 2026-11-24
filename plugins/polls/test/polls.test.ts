import type { Message, MessagePayload } from "@cicord/sdk";
import { callRoute, createTestContext, runCommand, runComponent } from "@cicord/sdk/testing";
import { describe, expect, test } from "vite-plus/test";
import schema from "../config.schema.json" with { type: "json" };
import plugin from "../src/index.ts";
import { nextSnowflake, parseChoices } from "../src/polls.ts";

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
    schema,
    config: { managerRoles: ["mod"], ...config },
    grants,
    plugin: { name: "polls" },
    roles: { mod: { name: "Moderator" }, events: { name: "Events" } },
    channels: { polls: { name: "polls" }, general: { name: "general" } },
    members: [
      { id: "1", username: "alice" },
      { id: "2", username: "bob" },
      { id: "3", username: "mia", roles: ["mod"] },
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
    const { payload } = await start(t, {
      thread: true,
      ping: { id: "role-events", name: "Events", mention: "<@&role-events>" },
    });
    expect(payload.content).toBe("<@&role-events> — new poll by <@1>");
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
    expect(t.published).toEqual([
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
    expect(t.published).toHaveLength(1);
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

test("helpers", () => {
  expect(parseChoices(" a | b ;a\nc ||")).toEqual(["a", "b", "c"]);
  expect(nextSnowflake("1299")).toBe("1300");
  expect(nextSnowflake("999")).toBe("1000");
});
