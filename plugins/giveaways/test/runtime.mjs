import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startSimulator } from "../../../scripts/simulator.mjs";
import { verify } from "./verify.mjs";

async function until(read, predicate, ms) {
  const end = Date.now() + ms;
  do {
    const value = await read();
    if (predicate(value)) return value;
    await delay(200);
  } while (Date.now() < end);
  assert.fail("Timed out waiting for giveaway state");
}
test(
  "a 30-second giveaway closes after plugin reload and its public proof reproduces the winners",
  { timeout: 95000 },
  async (t) => {
    const dir = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
    const grants = [
      "discord.messages.send",
      "discord.messages.read",
      "discord.channels.read",
      "discord.members.read",
      "discord.dm.send",
      "storage.kv",
      "scheduler",
      "portal.routes",
      "events.publish",
    ];
    const sim = await startSimulator(
        t,
        dir,
        grants,
        { enabled: true },
        { health: ["Healthy", "Degraded"] },
      ),
      token = await sim.login(sim.owner);
    const alice = sim.users.find((u) => u.username === "alice");
    await sim.join(alice);
    const modal = await sim.command(sim.owner, "giveaway start", { seconds: 30, winners: 1 });
    assert.equal(modal.status, "modal", JSON.stringify(modal));
    const submitted = await sim.api("/api/v1/sim/modals", {
      userId: sim.owner.id,
      serverId: sim.guild.id,
      channelId: sim.channel.id,
      bot: "bot",
      customId: modal.modal.customId,
      fields: { prize: "Book", description: "One copy" },
    });
    assert.equal(submitted.status, "replied", JSON.stringify(submitted));
    const list = () =>
      sim.api("/api/v1/portal/acceptance/plugins/bot/giveaways/giveaways", undefined, token);
    const opening = (await until(list, (p) => p.items?.length === 1, 6000)).items[0];
    assert.equal(opening.seed, undefined);
    const channelMessages = () => sim.api("/api/v1/sim/channels/" + sim.channel.id + "/messages");
    const posts = (value) =>
      (Array.isArray(value) ? value : (value.messages ?? value.items ?? [])).filter((m) =>
        m.embeds?.some((e) => e.title === "Book"),
      );
    const card = posts(await until(channelMessages, (v) => posts(v).length === 1, 6000))[0];
    const enter = card.components
      .flatMap((row) => row.components ?? [])
      .find((b) => b.label === "Enter");
    assert.ok(enter, JSON.stringify(card));
    const entry = await sim.api("/api/v1/sim/components", {
      userId: alice.id,
      messageId: card.id,
      channelId: sim.channel.id,
      customId: enter.customId,
    });
    assert.equal(entry.status, "replied", JSON.stringify(entry));
    // The dev runtime watches snapshots. A changed module restarts the plugin instance while
    // keeping this simulated guild and the outstanding scheduler task.
    const runtime = () => sim.api("/api/v1/status", undefined, "local-simulator-only");
    const before = (await runtime()).revision?.id;
    await appendFile(
      join(sim.repo, "plugins/giveaways/src/index.ts"),
      "\nconsole.info('Giveaway reload acceptance revision');\n",
    );
    await until(runtime, (s) => s.revision?.id && s.revision.id !== before, 12000);
    const detail = () =>
      sim.api("/api/v1/portal/acceptance/plugins/bot/giveaways/giveaways/" + opening.id);
    const done = await until(detail, (p) => p.state === "ended", 55000);
    assert.equal(done.commitment, opening.commitment);
    assert.deepEqual(verify({ seed: done.seed, id: done.id, entries: done.entries, count: 1 }), {
      commitment: opening.commitment,
      entrantsHash: done.entrantsHash,
      winners: [alice.id],
    });
    assert.deepEqual(done.winners, [alice.id]);
    assert.equal(posts(await channelMessages()).length, 1);
    const server = join(sim.repo, "servers/acceptance.yaml");
    const yaml = await readFile(server, "utf8");
    await writeFile(
      server,
      yaml.replace(
        "    general:\n",
        '    general:\n      overwrites:\n        "@everyone": {deny: [ReadMessageHistory]}\n        moderator: {allow: [ReadMessageHistory]}\n',
      ),
    );
    const path = "/api/v1/portal/acceptance/plugins/bot/giveaways/giveaways/" + opening.id;
    const aliceToken = await sim.login(alice);
    await until(
      async () => {
        try {
          await sim.api(path);
          return false;
        } catch (e) {
          if (!String(e).includes("404")) throw e;
          return true;
        }
      },
      Boolean,
      15000,
    );
    await assert.rejects(sim.api(path, undefined, aliceToken), /404/);
    const staff = await sim.api(path, undefined, token);
    assert.deepEqual(staff.winners, [alice.id]);
    assert.equal(staff.entrantsHash, done.entrantsHash);
  },
);
