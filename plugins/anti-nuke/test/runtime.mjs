import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { startSimulator } from "../../../scripts/simulator.mjs";

test("monitor starts without destructive grants and exposes staff review routes", async (t) => {
  const dir = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
  const grants = [
    "discord.auditlog.read",
    "discord.channels.read",
    "discord.messages.read",
    "discord.messages.send",
    "discord.members.read",
    "storage.kv",
    "scheduler",
    "portal.routes",
    "events.subscribe",
    "events.publish",
  ];
  const sim = await startSimulator(
    t,
    dir,
    grants,
    { trustedFromCommand: true },
    { health: ["Healthy", "Degraded"] },
  );
  const owner = await sim.login(sim.owner);
  const status = await sim.api(
    "/api/v1/portal/acceptance/plugins/bot/anti-nuke/status",
    undefined,
    owner,
  );
  assert.equal(status.mode, "monitor");
  assert.ok(
    status.warnings.some((message) => message.includes("Automatic restoration is disabled.")),
    JSON.stringify(status),
  );
  const runtime = await sim.api("/api/v1/status", undefined, "local-simulator-only");
  const instance = runtime.bots
    .flatMap((bot) => bot.plugins ?? [])
    .find((plugin) => plugin.instance === "anti-nuke");
  assert.equal(instance.health, "Degraded");
  assert.match(instance.message, /protection/i);
  assert.equal((await sim.command(sim.owner, "antinuke status")).status, "replied");
  const alice = sim.users.find((u) => u.username === "alice");
  await sim.join(alice);
  assert.equal(
    (await sim.command(sim.owner, "antinuke trust add", { user: alice.id })).status,
    "replied",
  );
  assert.equal(
    (await sim.command(sim.owner, "antinuke trust remove", { user: alice.id })).status,
    "replied",
  );
  const path = "/api/v1/portal/acceptance/plugins/bot/anti-nuke/incidents";
  assert.ok(Array.isArray((await sim.api(path, undefined, owner)).items));
  await assert.rejects(() => sim.api(path, undefined, undefined), /401/);
});
