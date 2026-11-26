import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { startSimulator } from "../../../scripts/simulator.mjs";

test("monitor records a simulated member's blocked link and preserves the message", async (t) => {
  const dir = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
  const grants = [
    "discord.channels.read",
    "discord.members.read",
    "discord.messages.send",
    "discord.messages.read",
    "storage.kv",
    "scheduler",
    "portal.routes",
    "events.publish",
    "events.subscribe",
  ];
  const sim = await startSimulator(t, dir, grants, { links: { domains: ["blocked.invalid"] } });
  const alice = sim.users.find((u) => u.username === "alice");
  await sim.join(alice);
  const message = await sim.api("/api/v1/sim/messages", {
    userId: alice.id,
    channelId: sim.channel.id,
    content: "https://blocked.invalid/example",
  });
  const staff = await sim.login(sim.owner),
    path = "/api/v1/portal/acceptance/plugins/bot/guard/violations";
  let record;
  for (let n = 0; n < 30 && !record; n++) {
    const page = await sim.api(path, undefined, staff);
    record = page.items
      .find((x) => x.userId === alice.id)
      ?.violations.find((v) => v.messageId === message.id);
    if (!record) await delay(100);
  }
  assert.equal(record?.rule, "links");
  assert.equal(record.action, "monitor");
  const messages = await sim.api("/api/v1/sim/channels/" + sim.channel.id + "/messages");
  assert.ok(messages.items.some((m) => m.id === message.id));
  await assert.rejects(() => sim.api(path, undefined, undefined), /401/);
});
