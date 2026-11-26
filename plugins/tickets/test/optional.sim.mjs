import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { startSimulator } from "../../../scripts/simulator.mjs";

const dir = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
// Least privilege: no discord.dm.send and no discord.messages.manage.
const grants = [
  "discord.messages.send",
  "discord.messages.read",
  "discord.channels.read",
  "discord.channels.manage",
  "discord.members.read",
  "storage.kv",
  "portal.routes",
  "portal.links",
  "events.publish",
  "scheduler",
];

test("without DM and message-management grants, the optional features are reported off and tickets still work", { timeout: 45000 }, async (t) => {
  const config = {
    panelChannel: "general",
    modmailType: "help",
    types: [
      {
        key: "help",
        name: "Help",
        staffRoles: ["moderator"],
        logChannel: "general",
        retainSourceForTranscript: true,
      },
    ],
  };
  const sim = await startSimulator(t, dir, grants, config, { health: ["Degraded"] });
  const status = await sim.api("/api/v1/status", undefined, "local-simulator-only");
  const instance = status.bots.flatMap((b) => b.plugins).find((p) => p.instance === "tickets");
  const advisories = Object.fromEntries(instance.advisories.map((a) => [a.feature, a.reason]));
  assert.equal(advisories.modmail, "discord.dm.send not granted");
  assert.equal(advisories.ratingPrompts, "discord.dm.send not granted");
  assert.equal(advisories.managedMessages, "discord.messages.manage not granted");
  assert.match(instance.message, /modmail: Modmail needs discord\.dm\.send/);
  assert.match(instance.message, /transcriptFiles: Transcript files need discord\.messages\.manage/);
  const alice = sim.users.find((u) => u.username === "alice");
  await sim.join(alice);
  const token = await sim.login(alice);
  const portal = (path, body) =>
    sim.api("/api/v1/portal/acceptance/plugins/bot/tickets/tickets" + path, body, token);
  const opened = await portal("", {
    subject: "Least privilege",
    type: "help",
    description: "Opened without DM grants",
  });
  assert.ok(opened.id);
  const mine = await portal("/mine");
  assert.deepEqual(
    mine.items.map((x) => x.id),
    [opened.id],
  );
});
