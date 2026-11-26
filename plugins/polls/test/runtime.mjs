import assert from "node:assert/strict";
import test from "node:test";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { startSimulator } from "../../../scripts/simulator.mjs";
const dir = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const grants = [
  "discord.messages.send",
  "discord.messages.read",
  "discord.channels.read",
  "discord.threads.manage",
  "discord.members.read",
  "storage.kv",
  "scheduler",
  "events.publish",
  "portal.routes",
];
test(
  "a simulated Discord member votes, closes an anonymous poll and reads aggregate portal results",
  { timeout: 45000 },
  async (t) => {
    const sim = await startSimulator(t, dir, grants, {});
    const voter = sim.users.find((u) => u.username === "alice");
    await sim.join(voter);
    const bad = await sim.command(sim.owner, "poll", {
      question: "When?",
      choices: "Fri|Sat",
      style: "native",
      anonymous: true,
    });
    assert.match(JSON.stringify(bad), /Native polls require/);
    assert.equal(
      (
        await sim.command(sim.owner, "poll", {
          question: "Vote now",
          choices: "Fri|Sat",
          anonymous: true,
        })
      ).status,
      "replied",
    );
    const { items } = await sim.api("/api/v1/sim/channels/" + sim.channel.id + "/messages");
    const card = items.find((m) => m.embeds?.some((e) => e.title?.includes("Vote now")));
    assert.ok(card);
    const click = await sim.api("/api/v1/sim/components", {
      channelId: sim.channel.id,
      messageId: card.id,
      userId: voter.id,
      customId: card.components[0].components[1].customId,
    });
    assert.equal(click.status, "replied");
    const close = await sim.command(sim.owner, "polls close", { poll: "1" });
    assert.match(JSON.stringify(close), /is closed/);
    const data = await sim.api(
      "/api/v1/portal/acceptance/plugins/bot/polls/polls/1",
      undefined,
      await sim.login(sim.owner),
    );
    assert.equal(data.voters, 1);
    assert.deepEqual(data.choices, [
      { label: "Fri", votes: 0 },
      { label: "Sat", votes: 1 },
    ]);
    assert.ok(!JSON.stringify(data).includes(voter.id));
  },
);

// Install both contract generations in the throw-away bot. Only these fixture
// subscribers expose their received event, through an administrator-only route.
async function observers({ repo }) {
  for (const [name, version] of [
    ["legacy", 1],
    ["current", 2],
  ]) {
    const root = join(repo, "plugins", name);
    await mkdir(join(root, "src"), { recursive: true });
    const contract =
      version === 2
        ? "  delivery: at-least-once\n  interop:\n    subscribes: [{topic: polls.closed, version: 2}]\n"
        : "";
    await writeFile(
      join(root, "plugin.yaml"),
      `apiVersion: cicord.dev/v1alpha1
kind: Plugin
metadata: {name: ${name}, version: 0.1.0}
spec:
  engine: ">=0.2.0-0"
  entry: ./src/index.ts
  capabilities: [events.subscribe,storage.kv,portal.routes]
${contract}`,
    );
    await writeFile(
      join(root, "src/index.ts"),
      `import {definePlugin} from "@cicord/sdk";
export default definePlugin({
 subscriptions:{"polls.closed":async(ctx,payload)=>{await ctx.kv.set("closed",payload);}},
 routes:{"GET /observed":{access:"admin",handler:async ctx=>await ctx.kv.get("closed")??null}}
});`,
    );
    await appendFile(
      join(repo, "bots", "bot", "bot.yaml"),
      `    - name: ${name}
      source: ../../plugins/${name}
      grants: [events.subscribe,storage.kv,portal.routes]
`,
    );
  }
}
test(
  "two Discord members exercise the native ballot and its versioned results",
  { timeout: 45000 },
  async (t) => {
    const sim = await startSimulator(t, dir, grants, {}, { prepare: observers });
    const creator = sim.users.find((u) => u.username === "alice"),
      voter = sim.users.find((u) => u.username === "bob");
    await sim.join(creator);
    await sim.join(voter);
    const posted = await sim.command(creator, "poll", {
      question: "Native A/B",
      choices: "A|B",
      style: "native",
      hours: 1,
    });
    assert.match(JSON.stringify(posted), /posted/);
    const messages = async () =>
      (await sim.api("/api/v1/sim/channels/" + sim.channel.id + "/messages")).items;
    const original = (await messages()).find((m) => m.poll?.question === "Native A/B");
    assert.ok(original);
    const [a, b] = original.poll.answers.map((answer) => answer.id);
    const route = "/api/v1/portal/acceptance/plugins/bot/polls/polls/1";
    const vote = (answerId, voted) =>
      sim.api("/api/v1/sim/poll-votes", {
        channelId: sim.channel.id,
        messageId: original.id,
        userId: voter.id,
        answerId,
        voted,
      });
    async function confirm(state, counts, total) {
      const native = (await messages()).find((m) => m.id === original.id).poll;
      assert.deepEqual(
        native.answers.map((x) => x.votes),
        counts,
      );
      assert.equal(native.finalized, state === "closed");
      const portal = await sim.api(route);
      assert.deepEqual(
        portal.choices.map((x) => x.votes),
        counts,
      );
      assert.equal(portal.status, state);
      assert.equal(portal.voters, total);
      assert.ok(!JSON.stringify(portal).includes(voter.id));
      assert.ok(!JSON.stringify(portal).includes(creator.id));
    }
    await confirm("open", [0, 0], 0);
    await vote(b, true);
    await confirm("open", [0, 1], 1);
    await vote(b, false);
    await confirm("open", [0, 0], 0);
    await vote(a, true);
    await confirm("open", [1, 0], 1);
    const denied = await sim.command(voter, "polls close", { poll: "1" });
    assert.match(JSON.stringify(denied), /Only the author/);
    await confirm("open", [1, 0], 1);
    const closed = await sim.command(creator, "polls close", { poll: "1" });
    assert.match(JSON.stringify(closed), /is closed/);
    await confirm("closed", [1, 0], 1);
    await assert.rejects(vote(b, true), /400/);
    for (const name of ["legacy", "current"]) {
      let event;
      for (let i = 0; i < 60 && !event; i++) {
        event = await sim.api(
          `/api/v1/portal/acceptance/plugins/bot/${name}/observed`,
          undefined,
          "local-simulator-only",
        );
        if (!event) await delay(100);
      }
      assert.ok(event, name);
      assert.deepEqual(event.choices, [
        { label: "A", votes: 1 },
        { label: "B", votes: 0 },
      ]);
      assert.deepEqual(event.winners, ["A"]);
      assert.deepEqual(event.voters, [voter.id]);
      assert.equal(event.closedBy, creator.id);
      assert.equal(event.voterCount, name === "current" ? 1 : undefined);
    }
  },
);
