import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { startSimulator } from "../../../scripts/simulator.mjs";
const dir = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
test(
  "a simulated Discord member votes, closes an anonymous poll and reads aggregate portal results",
  { timeout: 45000 },
  async (t) => {
    const sim = await startSimulator(
      t,
      dir,
      [
        "discord.messages.send",
        "discord.messages.read",
        "discord.channels.read",
        "discord.threads.manage",
        "discord.members.read",
        "storage.kv",
        "scheduler",
        "events.publish",
        "portal.routes",
      ],
      {},
    );
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
