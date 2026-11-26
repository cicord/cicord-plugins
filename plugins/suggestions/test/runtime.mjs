import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { startSimulator } from "../../../scripts/simulator.mjs";
test(
  "a submitted suggestion receives one changeable vote and only a moderator can approve it",
  { timeout: 35000 },
  async (t) => {
    const dir = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
    const sim = await startSimulator(
      t,
      dir,
      [
        "storage.kv",
        "scheduler",
        "portal.routes",
        "discord.messages.send",
        "discord.messages.read",
        "discord.channels.read",
        "discord.members.read",
        "discord.dm.send",
        "discord.threads.manage",
        "events.publish",
      ],
      { channel: "general", anonymous: true, retainText: true },
    );
    const alice = sim.users.find((u) => u.username === "alice"),
      bob = sim.users.find((u) => u.username === "bob");
    await sim.join(alice);
    await sim.join(bob);
    const route = "/api/v1/portal/acceptance/plugins/bot/suggestions";
    const modal = await sim.command(alice, "suggest");
    assert.equal(modal.status, "modal", JSON.stringify(modal));
    const msg = await sim.api("/api/v1/sim/modals", {
      userId: alice.id,
      serverId: sim.guild.id,
      channelId: sim.channel.id,
      bot: "bot",
      customId: modal.modal.customId,
      fields: { body: "Plant a community garden" },
    });
    assert.equal(msg.status, "replied", JSON.stringify(msg));
    const board = () => sim.api(route + "/suggestions");
    const initial = (await board()).items[0];
    assert.equal(initial.body, "Plant a community garden");
    assert.equal(initial.authorId, undefined);
    const cards = () => sim.api("/api/v1/sim/channels/" + sim.channel.id + "/messages");
    const card = (await cards()).items.find((m) =>
      m.embeds.some((e) => e.description === initial.body),
    );
    const [up, down] = card.components[0].components;
    const click = (b) =>
      sim.api("/api/v1/sim/components", {
        userId: bob.id,
        channelId: sim.channel.id,
        messageId: card.id,
        customId: b.customId,
      });
    for (const b of [up, up, down]) assert.equal((await click(b)).status, "replied");
    assert.equal((await board()).items[0].score, -1);
    const body = { status: "approved", reason: "The garden team confirmed the site" };
    await assert.rejects(
      sim.api(route + "/suggestions/" + initial.id + "/status", body, await sim.login(bob)),
      /403/,
    );
    const decision = await sim.api(
      route + "/suggestions/" + initial.id + "/status",
      body,
      await sim.login(sim.owner),
    );
    assert.equal(decision.authorId, alice.id);
    assert.equal(decision.status, "approved");
    let updated = false;
    for (let n = 0; n < 50; n++) {
      const fresh = (await cards()).items.find((m) => m.id === card.id);
      if (fresh?.embeds[0]?.fields?.some((f) => f.value === body.reason)) {
        updated = true;
        break;
      }
      await delay(100);
    }
    assert.ok(updated, "Public suggestion card did not reflect the staff decision");
    const bobToken = await sim.login(bob),
      ownerToken = await sim.login(sim.owner);
    await sim.api("/api/v1/sim/channels/" + sim.channel.id + "/permissions", {
      overwrites: [{ type: "role", id: sim.guild.id, deny: ["ReadMessageHistory"] }],
    });
    for (let n = 0; n < 40; n++) {
      if (!(await board()).items.length) break;
      await delay(100);
    }
    assert.deepEqual((await board()).items, []);
    assert.deepEqual((await sim.api(route + "/suggestions", undefined, bobToken)).items, []);
    const staff = await sim.api(route + "/suggestions/moderation", undefined, ownerToken);
    assert.equal(staff.items[0].id, initial.id);
    assert.equal(staff.items[0].status, "approved");
  },
);
