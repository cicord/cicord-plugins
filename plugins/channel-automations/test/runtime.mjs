import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { startSimulator } from "../../../scripts/simulator.mjs";

test(
  "a simulator media-only rule withholds moderation without the intent and optional grants",
  { timeout: 30000 },
  async (t) => {
    const dir = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
    const sim = await startSimulator(
      t,
      dir,
      ["storage.kv", "scheduler", "discord.channels.read", "discord.messages.read"],
      { rules: [{ channel: "general", mediaOnly: true }] },
    );
    const alice = sim.users.find((u) => u.username === "alice");
    await sim.join(alice);
    await sim.api("/api/v1/sim/messages", {
      userId: alice.id,
      channelId: sim.channel.id,
      content: "A text-only message",
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const { items } = await sim.api("/api/v1/sim/channels/" + sim.channel.id + "/messages");
    assert.ok(items.some((m) => m.content === "A text-only message"));
  },
);
