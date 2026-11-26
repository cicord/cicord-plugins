import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { startSimulator } from "../../../scripts/simulator.mjs";

test(
  "daily claims use the persisted member wallet on simulated Discord",
  { timeout: 60000 },
  async (t) => {
    const dir = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
    const sim = await startSimulator(
      t,
      dir,
      ["storage.kv", "discord.messages.send", "portal.routes", "events.publish", "scheduler"],
      { enabled: true, daily: 25 },
    );
    const user = sim.users.find((u) => u.username === "alice");
    await sim.join(user);
    const token = await sim.login(user);
    const wallet = () =>
      sim.api("/api/v1/portal/acceptance/plugins/bot/economy/wallet", undefined, token);
    for (let i = 0; i < 2; i++) {
      assert.equal((await sim.command(user, "daily")).status, "replied");
      assert.equal((await wallet()).balance, 25);
    }
  },
);
