import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { startSimulator } from "../../../scripts/simulator.mjs";

test("a member challenge reaches the real simulator role and portal", async (t) => {
  const dir = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
  const grants = [
    "discord.channels.read",
    "discord.messages.read",
    "discord.messages.send",
    "discord.members.read",
    "discord.roles.assign",
    "storage.kv",
    "scheduler",
    "portal.routes",
    "portal.links",
    "events.publish",
  ];
  const sim = await startSimulator(t, dir, grants, {
    panelChannel: "general",
    verifiedRole: "member",
    method: "button",
    minAccountAgeDays: 0,
  });
  const alice = sim.users.find((u) => u.username === "alice");
  await sim.join(alice);
  const token = await sim.login(alice),
    path = "/api/v1/portal/acceptance/plugins/bot/verification/challenge";
  const challenge = await sim.api(path, undefined, token);
  assert.equal(challenge.method, "button");
  assert.deepEqual(await sim.api(path, { id: challenge.id }, token), { verified: true });
  assert.deepEqual(await sim.api(path, undefined, token), { verified: true });
  assert.equal((await sim.command(sim.owner, "verify-panel")).status, "replied");
  await assert.rejects(() => sim.api(path, undefined, undefined), /401/);
});

test("the visual challenge renders with the real confined renderer", async (t) => {
  const dir = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
  const grants = [
    "discord.channels.read",
    "discord.messages.read",
    "discord.messages.send",
    "discord.members.read",
    "discord.roles.assign",
    "storage.kv",
    "scheduler",
    "portal.routes",
    "portal.links",
    "events.publish",
    "render",
  ];
  const sim = await startSimulator(t, dir, grants, {
    panelChannel: "general",
    verifiedRole: "member",
    method: "visual",
    minAccountAgeDays: 0,
  });
  const alice = sim.users.find((u) => u.username === "alice");
  await sim.join(alice);
  const token = await sim.login(alice),
    path = "/api/v1/portal/acceptance/plugins/bot/verification/challenge";
  const challenge = await sim.api(path, undefined, token);
  assert.equal(challenge.method, "visual");
  assert.match(challenge.image, /^data:image\/png;base64,iVBOR/);
  assert.equal(new Set(challenge.choices).size, 12);
  assert.ok(challenge.choices.every((n) => Number.isInteger(n) && n >= 1000 && n <= 9999));
});

test("the default typed challenge renders with the real confined renderer", async (t) => {
  const dir = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
  const grants = [
    "discord.channels.read",
    "discord.messages.read",
    "discord.messages.send",
    "discord.members.read",
    "discord.roles.assign",
    "storage.kv",
    "scheduler",
    "portal.routes",
    "portal.links",
    "events.publish",
    "render",
  ];
  const sim = await startSimulator(t, dir, grants, {
    panelChannel: "general",
    verifiedRole: "member",
    minAccountAgeDays: 0,
  });
  const alice = sim.users.find((u) => u.username === "alice");
  await sim.join(alice);
  const token = await sim.login(alice),
    path = "/api/v1/portal/acceptance/plugins/bot/verification/challenge";
  const challenge = await sim.api(path, undefined, token);
  assert.equal(challenge.method, "typed");
  assert.equal(challenge.kind, "typed");
  assert.equal(challenge.length, 6);
  assert.match(challenge.image, /^data:image\/png;base64,iVBOR/);
  assert.equal(challenge.choices, undefined);
});
