import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { startSimulator } from "../../../scripts/simulator.mjs";

const dir = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
// No discord.messages.read: the privacyCopies feature is off, so the announcement cannot be
// redacted. The privacy hook must still erase the stored data and report it (COM-16).
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
];

test(
  "erasure in the runtime removes the member's data without privacyCopies and reports it",
  { timeout: 120000 },
  async (t) => {
    const sim = await startSimulator(
      t,
      dir,
      grants,
      { xpPerMessage: 100, cooldownSeconds: 0 },
      { health: ["Healthy", "Degraded"] },
    );
    const alice = sim.users.find((u) => u.username === "alice"),
      bob = sim.users.find((u) => u.username === "bob");
    await sim.join(alice);
    await sim.join(bob);
    for (const user of [alice, bob])
      await sim.api("/api/v1/sim/messages", {
        userId: user.id,
        channelId: sim.channel.id,
        content: "hello there everyone",
      });
    const board = async () =>
      (await sim.api("/api/v1/portal/acceptance/plugins/bot/levels/leaderboard")).items;
    let items = [];
    for (let i = 0; i < 100 && items.length < 2; i++) {
      items = await board();
      if (items.length < 2) await delay(100);
    }
    assert.equal(items.length, 2, sim.logs());
    const announced = async () =>
      (await sim.api("/api/v1/sim/channels/" + sim.channel.id + "/messages")).items.filter((m) =>
        m.content?.includes("level 1"),
      );
    for (let i = 0; i < 100 && (await announced()).length < 2; i++) await delay(100);
    const erased = await sim.api(
      "/api/v1/servers/acceptance/privacy/erase",
      { userId: alice.id },
      "local-simulator-only",
    );
    t.diagnostic(JSON.stringify(erased));
    assert.doesNotMatch(JSON.stringify(erased), /"error"|failed/i, sim.logs());
    assert.deepEqual(
      (await board()).map((e) => e.userId),
      [bob.id],
    );
    const status = await sim.api("/api/v1/status", undefined, "local-simulator-only");
    const levels = status.bots.flatMap((b) => b.plugins).find((p) => p.instance === "levels");
    assert.match(JSON.stringify(levels), /privacy-copies|could not be redacted/, JSON.stringify(levels));
    assert.doesNotMatch(sim.logs(), /plugin handler failed[^\n]*privacy/);
  },
);
