import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { startSimulator } from "../../../scripts/simulator.mjs";

test(
  "erasing an active quarantine withdraws staff copies and preserves its scheduled release",
  { timeout: 100_000 },
  async (t) => {
    const dir = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
    const grants = [
      "discord.messages.send",
      "discord.messages.manage",
      "discord.messages.read",
      "discord.channels.read",
      "discord.members.read",
      "discord.auditlog.read",
      "discord.members.moderate",
      "discord.dm.send",
      "storage.kv",
      "http.fetch",
      "portal.routes",
      "events.publish",
      "scheduler",
      "discord.roles.assign",
    ];
    const sim = await startSimulator(t, dir, grants, {
      logChannel: "general",
      quarantineRole: "member",
    });
    const member = sim.users.find((u) => u.username === "alice");
    await sim.join(member);
    const result = await sim.command(sim.owner, "quarantine", {
      user: member.id,
      reason: "private quarantine evidence",
      duration: 1,
    });
    assert.equal(result.status, "replied", JSON.stringify(result));
    const role = sim.guild.roles.find((r) => r.name === "Member");
    async function quarantined() {
      const state = await sim.api("/api/v1/sim/state");
      const target = state.servers[0].members.find((m) => m.user.id === member.id);
      return target?.roles.includes(role.id);
    }
    assert.equal(await quarantined(), true);
    const messages = async () =>
      (await sim.api("/api/v1/sim/channels/" + sim.channel.id + "/messages")).items;
    assert.match(JSON.stringify(await messages()), /private quarantine evidence/);
    const report = await sim.api(
      "/api/v1/servers/acceptance/privacy/erase",
      { userId: member.id },
      "local-simulator-only",
    );
    assert.ok(report.complete, JSON.stringify(report));
    const notices = await messages();
    assert.doesNotMatch(
      JSON.stringify(notices.flatMap((m) => m.embeds ?? [])),
      new RegExp("private quarantine evidence|" + member.id),
    );
    assert.equal(await quarantined(), true);
    for (let n = 0; n < 75; n++) {
      if (!(await quarantined())) {
        assert.doesNotMatch(
          JSON.stringify((await messages()).flatMap((m) => m.embeds ?? [])),
          new RegExp("private quarantine evidence|" + member.id),
        );
        return;
      }
      await delay(1000);
    }
    assert.fail("quarantine role survived its expiry after privacy erasure");
  },
);
