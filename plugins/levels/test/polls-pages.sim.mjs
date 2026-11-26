import assert from "node:assert/strict";
import test from "node:test";
import { appendFile, cp, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { startSimulator } from "../../../scripts/simulator.mjs";

const dir = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const pollsDir = fileURLToPath(new URL("../../polls", import.meta.url));
const grants = [
  "discord.messages.send",
  "discord.reactions.manage",
  "discord.channels.read",
  "discord.members.read",
  "discord.roles.assign",
  "storage.kv",
  "scheduler",
  "portal.routes",
  "portal.links",
  "events.subscribe",
  "plugins.query:polls.voters",
];
const pollsGrants = [
  "discord.messages.send",
  "discord.messages.read",
  "discord.channels.read",
  "discord.members.read",
  "storage.kv",
  "scheduler",
  "events.publish",
  "portal.routes",
];

// The real polls plugin publishes the real polls.closed v2 event. The fixture entry forwards
// it to the production levels subscriber as if it were truncated (above 10,000 voters), so
// levels must page the voters through the runtime, which validates the call input against
// the polls voters.v1 contract (SPC-2).
async function prepare({ repo, pluginDir }) {
  await cp(pollsDir, join(repo, "plugins", "polls"), {
    recursive: true,
    filter: (p) => ![".cicord", "node_modules", "dist", ".git"].includes(basename(p)),
  });
  await appendFile(
    join(repo, "bots", "bot", "bot.yaml"),
    `    - name: polls
      source: ../../plugins/polls
      grants: ${JSON.stringify(pollsGrants)}
      config: {}
`,
  );
  const manifest = join(pluginDir, "plugin.yaml");
  await writeFile(
    manifest,
    (await readFile(manifest, "utf8")).replace("entry: ./src/index.ts", "entry: ./src/fixture.ts"),
  );
  await writeFile(
    join(pluginDir, "src/fixture.ts"),
    `import {definePlugin} from "@cicord/sdk";
import levels from "./index.ts";
const closed = levels.subscriptions!["polls.closed"]!;
export default definePlugin({...levels, subscriptions: {...levels.subscriptions,
  async "polls.closed"(ctx, payload, meta) {
    const {voters, ...rest} = payload as Record<string, unknown>;
    void voters;
    await closed(ctx, {...rest, votersTruncated: true}, meta);
  }}});
`,
  );
}

test(
  "a truncated poll pages its voters through the real polls.voters contract",
  { timeout: 120000 },
  async (t) => {
    const sim = await startSimulator(
      t,
      dir,
      grants,
      { pollBonusXp: 7 },
      { prepare, health: ["Healthy", "Degraded"] },
    );
    const alice = sim.users.find((u) => u.username === "alice"),
      bob = sim.users.find((u) => u.username === "bob");
    await sim.join(alice);
    await sim.join(bob);
    const posted = await sim.command(sim.owner, "poll", { question: "Paged?", choices: "A|B" });
    assert.match(JSON.stringify(posted), /posted/);
    const { items } = await sim.api("/api/v1/sim/channels/" + sim.channel.id + "/messages");
    const card = items.find((m) => m.embeds?.some((e) => e.title?.includes("Paged?")));
    assert.ok(card);
    for (const [user, n] of [
      [alice, 0],
      [bob, 1],
    ])
      assert.equal(
        (
          await sim.api("/api/v1/sim/components", {
            channelId: sim.channel.id,
            messageId: card.id,
            userId: user.id,
            customId: card.components[0].components[n].customId,
          })
        ).status,
        "replied",
      );
    assert.match(
      JSON.stringify(await sim.command(sim.owner, "polls close", { poll: "1" })),
      /closed/,
    );
    let board;
    for (let i = 0; i < 200; i++) {
      board = await sim.api("/api/v1/portal/acceptance/plugins/bot/levels/leaderboard");
      if (board.items.length === 2) break;
      await delay(100);
    }
    assert.deepEqual(
      board.items.map((e) => [e.userId, e.xp]).toSorted(),
      [
        [alice.id, 7],
        [bob.id, 7],
      ].toSorted(),
      sim.logs(),
    );
    assert.doesNotMatch(sim.logs(), /invalid_input/);
  },
);
