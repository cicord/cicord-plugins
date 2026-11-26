import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { startSimulator } from "../../../scripts/simulator.mjs";

test("server opt-ins and viewer-scoped birthday form", { timeout: 30000 }, async (t) => {
  const dir = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
  const sim = await startSimulator(
    t,
    dir,
    [
      "storage.kv",
      "scheduler",
      "discord.channels.read",
      "discord.messages.send",
      "discord.members.read",
      "events.publish",
      "portal.routes",
    ],
    { channel: "general" },
  );
  const alice = sim.users.find((u) => u.username === "alice");
  await sim.join(alice);
  const result = await sim.command(alice, "birthday set", { day: 29, month: 2 });
  assert.equal(result.status, "replied", JSON.stringify(result));
  const route = "/api/v1/portal/acceptance/plugins/bot/birthdays/birthday";
  assert.deepEqual(await sim.api(route, undefined, await sim.login(alice)), {
    birthday: { day: 29, month: 2 },
  });
  assert.deepEqual(await sim.api(route, undefined, await sim.login(sim.owner)), { birthday: null });
  await sim.command(alice, "birthday remove");
  assert.deepEqual(await sim.api(route, undefined, await sim.login(alice)), { birthday: null });
});
