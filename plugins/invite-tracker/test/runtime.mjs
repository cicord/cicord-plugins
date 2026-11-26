import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { startSimulator } from "../../../scripts/simulator.mjs";
const dir = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
import { setTimeout as delay } from "node:timers/promises";
test(
  "gateway joins without an invite remain unattributed; leaderboard access needs membership",
  { timeout: 45000 },
  async (t) => {
    const sim = await startSimulator(
      t,
      dir,
      ["discord.invites.read", "storage.kv", "events.publish", "portal.routes"],
      { minAccountDays: 0 },
    );
    const alice = sim.users.find((u) => u.username === "alice");
    await sim.join(alice);
    const route = "/api/v1/portal/acceptance/plugins/bot/invite-tracker/leaderboard";
    await assert.rejects(sim.api(route), /401/);
    assert.deepEqual(await sim.api(route, undefined, await sim.login(alice)), []);
    const count = await sim.command(alice, "invites");
    assert.match(JSON.stringify(count), /0 valid/);
    const auth = "local-simulator-only";
    for (let n = 0; n < 40; n++) {
      const report = await sim.api(
        "/api/v1/servers/acceptance/privacy/export",
        { userId: alice.id },
        auth,
      );
      const item = report.plugins.find(
        (p) => p.instance.endsWith("invite-tracker") || p.instance.includes("/invite-tracker"),
      );
      const entry = item?.data?.find((e) => e.id === alice.id);
      if (entry) {
        assert.equal(entry.entry.inviterId, undefined);
        assert.equal(entry.entry.code, undefined);
        assert.equal(entry.entry.left, false);
        return;
      }
      await delay(100);
    }
    assert.fail("member join never appeared in the plugin privacy export");
  },
);
