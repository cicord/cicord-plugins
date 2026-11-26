import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { startSimulator } from "../../../scripts/simulator.mjs";

test(
  "a member who lacks the configured staff role is refused at both entry points",
  { timeout: 30000 },
  async (t) => {
    const dir = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
    const sim = await startSimulator(
      t,
      dir,
      ["storage.kv", "scheduler", "discord.roles.assign", "discord.members.read", "portal.routes"],
      { staffRole: "moderator", dutyRole: "member" },
    );
    const alice = sim.users.find((u) => u.username === "alice");
    await sim.join(alice);
    const r = await sim.command(alice, "duty on");
    assert.match(JSON.stringify(r), /staff role/);
    const token = await sim.login(alice),
      base = "/api/v1/portal/acceptance/plugins/bot/staff-shifts";
    await assert.rejects(() => sim.api(base + "/me", undefined, token), /403/);
    await assert.rejects(() => sim.api(base + "/coverage", undefined, token), /403/);
  },
);
