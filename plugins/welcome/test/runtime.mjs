import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { startSimulator } from "../../../scripts/simulator.mjs";

test(
  "a French greeting is delivered on joining the simulated server",
  { timeout: 30000 },
  async (t) => {
    const dir = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
    const sim = await startSimulator(
      t,
      dir,
      [
        "storage.kv",
        "discord.messages.send",
        "discord.members.read",
        "discord.channels.read",
        "render",
      ],
      { channel: "general", locale: "fr", dmOnboarding: false, card: true },
    );
    const alice = sim.users.find((u) => u.username === "alice");
    await sim.join(alice);
    const { setTimeout: wait } = await import("node:timers/promises");
    for (let n = 0; n < 30; n++) {
      const { items } = await sim.api("/api/v1/sim/channels/" + sim.channel.id + "/messages");
      if (
        items.some(
          (m) =>
            m.content.includes("Bienvenue") &&
            m.content.includes(alice.id) &&
            m.embeds?.some((e) => e.imageUrl === "attachment://welcome.png"),
        )
      )
        return;
      await wait(150);
    }
    assert.fail("The simulated join did not produce the localized greeting.");
  },
);
