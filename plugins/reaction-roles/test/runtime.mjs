import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { startSimulator } from "../../../scripts/simulator.mjs";

test(
  "two members use real emoji and button panels with private eligibility and channel denials",
  { timeout: 30000 },
  async (t) => {
    const grants = [
      "discord.messages.send",
      "discord.messages.read",
      "discord.channels.read",
      "discord.roles.assign",
      "discord.members.read",
      "discord.reactions.manage",
      "storage.kv",
    ];
    const panels = [
      {
        name: "access",
        channel: "general",
        title: "Access",
        style: "reactions",
        options: [{ role: "member", emoji: "📬" }],
      },
      {
        name: "alerts",
        channel: "general",
        title: "Alerts",
        requiredRole: "member",
        options: [{ role: "updates" }],
      },
      {
        name: "private",
        channel: "members-only",
        title: "Member desk",
        options: [{ role: "updates" }],
      },
    ];
    const sim = await startSimulator(
      t,
      fileURLToPath(new URL("..", import.meta.url)),
      grants,
      { panels },
      {
        async prepare({ repo }) {
          const file = join(repo, "servers/acceptance.yaml");
          const yaml = await readFile(file, "utf8");
          await writeFile(
            file,
            yaml
              .replace("  roles:\n", "  roles:\n    updates: {name: Updates}\n")
              .replace("hierarchy: [moderator, member]", "hierarchy: [moderator, member, updates]")
              .replace(
                "  channels:\n",
                `  channels:
    members-only:
      name: members-only
      type: text
      overwrites:
        "@everyone": {deny: [ViewChannel]}
        member: {allow: [ViewChannel, ReadMessageHistory]}
        "@bot": {allow: [ViewChannel, SendMessages, ReadMessageHistory]}
`,
              ),
          );
        },
      },
    );
    const alice = sim.users.find((u) => u.username === "alice"),
      bob = sim.users.find((u) => u.username === "bob");
    assert.ok(alice && bob);
    await sim.join(alice);
    await sim.join(bob);
    const state = async () =>
      (await sim.api("/api/v1/sim/state")).servers.find((s) => s.id === sim.guild.id);
    const guild = await state(),
      member = guild.roles.find((r) => r.name === "Member"),
      updates = guild.roles.find((r) => r.name === "Updates");
    assert.ok(member && updates);
    async function hasRole(user, role, expected) {
      const end = Date.now() + 4000;
      do {
        const row = (await state()).members.find((m) => m.user.id === user.id);
        if (row && row.roles.includes(role.id) === expected) return;
        await delay(25);
      } while (Date.now() < end);
      assert.fail(`${user.username}: expected membership of ${role.name} to be ${expected}`);
    }
    const messages = async (id) =>
      (await sim.api("/api/v1/sim/channels/" + id + "/messages")).items;
    const find = async (id, title) => {
      for (let n = 0; n < 100; n++) {
        const entry = (await messages(id)).find((m) => m.embeds.some((e) => e.title === title));
        if (entry) return entry;
        await delay(25);
      }
      assert.fail("Missing panel " + title);
    };
    const access = await find(sim.channel.id, "Access");
    const gate = await find(sim.channel.id, "Alerts");
    const privateRoom = guild.channels.find((c) => c.name === "members-only");
    assert.ok(privateRoom);
    const privatePanel = await find(privateRoom.id, "Member desk");
    const click = (who, panel) =>
      sim.api("/api/v1/sim/components", {
        userId: who.id,
        channelId: panel.channelId,
        messageId: panel.id,
        customId: panel.components[0].components[0].customId,
      });
    const reaction = (who, method) =>
      sim.api(
        `/api/v1/sim/channels/${sim.channel.id}/messages/${access.id}/reactions/${encodeURIComponent("📬")}/${who.id}`,
        undefined,
        undefined,
        method,
      );

    const initial = (await messages(sim.channel.id)).map((m) => m.id);
    for (const user of [alice, bob]) {
      await hasRole(user, member, false);
      await hasRole(user, updates, false);
    }
    const refused = await click(bob, gate);
    assert.equal(refused.status, "replied");
    assert.ok(refused.response.ephemeral);
    assert.match(refused.response.content, /need.*Member/i);
    assert.deepEqual(
      (await messages(sim.channel.id)).map((m) => m.id),
      initial,
    );
    assert.equal((await click(bob, privatePanel)).status, "failed");
    await hasRole(bob, updates, false);

    await reaction(alice, "PUT");
    await hasRole(alice, member, true);
    await hasRole(bob, member, false);
    const granted = await click(alice, privatePanel);
    assert.equal(granted.status, "replied");
    assert.ok(granted.response.ephemeral);
    await hasRole(alice, updates, true);
    const removed = await click(alice, gate);
    assert.equal(removed.status, "replied");
    await hasRole(alice, updates, false);
    await reaction(alice, "DELETE");
    await hasRole(alice, member, false);
    assert.equal((await click(alice, privatePanel)).status, "failed");
    const revoked = await click(alice, gate);
    assert.ok(revoked.response.ephemeral);
    assert.match(revoked.response.content, /need.*Member/i);
    await hasRole(alice, updates, false);
    await hasRole(bob, updates, false);
  },
);
