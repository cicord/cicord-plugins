import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { startSimulator } from "../../../scripts/simulator.mjs";

// MOD-03 on the real core: /lock also holds against a role with an explicit Send Messages
// allow, while the staff role keeps its allow.
test("/lock also holds against a role allow of Send Messages, not against staff", async (t) => {
  const dir = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
  const sim = await startSimulator(
    t,
    dir,
    [
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
      "server.overlays",
    ],
    { logChannel: "welcome" },
  );
  const token = "local-simulator-only";
  const [alice, bob] = ["alice", "bob"].map((n) => sim.users.find((u) => u.username === n));
  for (const u of [alice, bob]) await sim.join(u);
  // Declare Alice a member and Bob a moderator; both roles allow Send Messages in #general.
  const file = join(sim.repo, "servers", "acceptance.yaml");
  let yaml = await readFile(file, "utf8");
  for (const [anchor, insert] of [
    ['      color: "#3498db"\n', `      members: ["${alice.id}"]\n`],
    ["      permissions: [KickMembers, ModerateMembers, ManageMessages]\n", `      members: ["${bob.id}"]\n`],
    [
      "      category: community\n      position: 1\n",
      "      overwrites:\n        \"@everyone\": {deny: [SendMessages]}\n        member: {allow: [SendMessages]}\n        moderator: {allow: [SendMessages]}\n",
    ],
  ]) {
    assert.ok(yaml.includes(anchor), anchor);
    yaml = yaml.replace(anchor, anchor + insert);
  }
  await writeFile(file, yaml);
  let last = "";
  const send = async (user) => {
    try {
      await sim.api("/api/v1/sim/messages", { userId: user.id, channelId: sim.channel.id, content: "hi" });
      return true;
    } catch (error) {
      last = String(error).slice(0, 300);
      return false;
    }
  };
  const until = async (fn, want) => {
    for (let i = 0; i < 150; i++) {
      if ((await fn()) === want) return true;
      await delay(100);
    }
    return false;
  };
  const roles = async () => {
    const server = (await sim.api("/api/v1/sim/state")).servers[0];
    const names = Object.fromEntries(server.roles.map((r) => [r.id, r.name]));
    return server.members
      .filter((m) => [alice.id, bob.id].includes(m.user.id))
      .map((m) => m.user.username + ":" + m.roles.map((r) => names[r]).join(","))
      .sort()
      .join(" ");
  };
  assert.ok(
    await until(roles, "alice:Member bob:Moderator"),
    "the declared roles were not applied: " + (await roles()) + sim.logs(),
  );
  assert.ok(await until(() => send(alice), true), "the member role allow was not applied");
  assert.ok(await until(() => send(bob), true), "the moderator role allow was not applied");
  const result = await sim.command(sim.owner, "lock", { channel: sim.channel.id, duration: 30 });
  assert.equal(result.status, "replied", JSON.stringify(result));
  assert.doesNotMatch(result.response.content, /refused|nothing was applied/i, result.response.content);
  assert.ok(await until(() => send(alice), false), "a member role allow bypassed the lock");
  assert.equal(await send(bob), true, "the lock silenced the staff role: " + last);
  // An administrator lifts the lock from the admin API, as on the Plan page.
  await sim.api("/api/v1/servers/acceptance/overlays/bot/moderation/lock-general", undefined, token, "DELETE");
  assert.ok(await until(() => send(alice), true), "lifting the lock did not restore the allow");
  const after = await sim.api("/api/v1/servers/acceptance/plan", undefined, token);
  assert.equal(after.changes.length, 0, JSON.stringify(after.changes));
});
