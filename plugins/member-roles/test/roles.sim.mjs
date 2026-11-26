import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { startSimulator } from "../../../scripts/simulator.mjs";

test(
  "temporary role commands enforce manager access and revoke after expiry",
  { timeout: 30000 },
  async (t) => {
    const sim = await startSimulator(
      t,
      fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, ""),
      [
        "discord.channels.read",
        "discord.messages.send",
        "discord.roles.assign",
        "discord.members.read",
        "storage.kv",
        "scheduler",
        "events.publish",
      ],
      { enabled: true, temp: { managerRoles: ["moderator"], roles: ["member"] } },
    );
    const role = sim.guild.roles.find((r) => r.name === "Member"),
      alice = sim.users.find((u) => u.username === "alice");
    assert.ok(role && alice);
    await sim.join(alice);
    const args = { user: alice.id, role: role.id, duration: "2s" };
    assert.match(
      (await sim.command(alice, "temprole add", args)).response.content,
      /cannot manage/i,
    );
    assert.match((await sim.command(sim.owner, "temprole add", args)).response.content, /granted/i);
    const currentRoles = async () => {
      const state = await sim.api("/api/v1/sim/state");
      return state.servers
        .find((s) => s.id === sim.guild.id)
        .members.find((m) => m.user.id === alice.id).roles;
    };
    assert.ok(
      (await currentRoles()).includes(role.id),
      "Discord member received the temporary role",
    );
    let expired = false;
    for (let i = 0; i < 40; i++) {
      const result = await sim.command(sim.owner, "temprole list", { user: alice.id });
      if (result.response.content === "No temporary roles.") {
        expired = true;
        break;
      }
      await delay(100);
    }
    assert.ok(expired, "temporary grant should expire through the durable scheduler");
    assert.ok(
      !(await currentRoles()).includes(role.id),
      "Discord member no longer holds the expired role",
    );
  },
);
