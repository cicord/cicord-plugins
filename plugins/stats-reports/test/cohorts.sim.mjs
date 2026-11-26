import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startSimulator } from "../../../scripts/simulator.mjs";
const dir = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");

// The host scopes ctx.privacy.pseudonym to privacy hooks: the cohort handlers must work
// without it in the real runtime, with the optional ServerMembers feature granted.
test(
  "with cohorts granted, a join and a departure within 7 days are counted and the instance stays healthy",
  { timeout: 100000 },
  async (t) => {
    const DAY = 86400000,
      today = new Date(),
      midnight = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()),
      weekEnd = midnight - ((today.getUTCDay() + 6) % 7) * DAY + 7 * DAY;
    const sim = await startSimulator(
      t,
      dir,
      [
        "analytics.read",
        "discord.channels.read",
        "discord.messages.send",
        "scheduler",
        "storage.kv",
        "discord.messages.read",
        "discord.members.read",
      ],
      { staffChannel: "reports", locale: "fr" },
      {
        health: ["Healthy", "Degraded"],
        async prepare({ repo, pluginDir }) {
          const server = join(repo, "servers/acceptance.yaml");
          await writeFile(
            server,
            (await readFile(server, "utf8")).replace(
              "  channels:",
              '  analytics: {enabled: true}\n  channels:\n    reports:\n      name: reports\n      type: text\n      overwrites:\n        "@everyone": {deny: [ViewChannel]}\n        "@bot": {allow: [ViewChannel, SendMessages]}',
            ),
          );
          const manifest = join(pluginDir, "plugin.yaml");
          await writeFile(
            manifest,
            (await readFile(manifest, "utf8")).replace(
              "entry: ./src/index.ts",
              "entry: ./src/test-clock.ts",
            ),
          );
          await writeFile(
            join(pluginDir, "src/test-clock.ts"),
            `import {command,definePlugin} from "@cicord/sdk";import plugin,{publish} from "./index.ts";
 export default definePlugin({...plugin,commands:{...plugin.commands,reporttest:command({description:"Run the weekly report in this disposable fixture",async run(ctx,it){await publish(ctx,"week",${weekEnd});await it.reply({content:"done",ephemeral:true});}})}});`,
          );
        },
      },
    );
    const auth = "local-simulator-only";
    const instance = async () =>
      (await sim.api("/api/v1/status", undefined, auth)).bots
        .flatMap((b) => b.plugins)
        .find((p) => p.instance === "stats-reports");
    const joinedAt = async (user) => {
      const report = await sim.api(
        "/api/v1/servers/acceptance/privacy/export",
        { userId: user.id },
        auth,
      );
      return (
        report.plugins.find((p) => p.instance.endsWith("stats-reports"))?.data?.joinedAt ?? null
      );
    };
    async function until(read, ok, what) {
      for (let n = 0; n < 100; n++) {
        if (ok(await read())) return;
        await delay(100);
      }
      assert.fail(`${what}: ${JSON.stringify(await instance())}\n${sim.logs()}`);
    }
    // Only the two ungranted optional features are reported; cohorts is active.
    const baseline = await instance();
    assert.ok(!baseline.advisories?.some((a) => a.feature === "cohorts"), JSON.stringify(baseline));
    const alice = sim.users.find((u) => u.username === "alice");
    await sim.join(alice);
    await until(
      () => joinedAt(alice),
      (v) => typeof v === "number",
      "join marker never recorded",
    );
    await sim.api(
      `/api/v1/sim/servers/${sim.guild.id}/members/${alice.id}`,
      undefined,
      auth,
      "DELETE",
    );
    await until(
      () => joinedAt(alice),
      (v) => v === null,
      "departure never consumed the marker",
    );
    const status = await instance();
    // The runtime logs every thrown handler; none may come from the cohort handlers.
    assert.doesNotMatch(sim.logs(), /plugin handler failed[^\n]*name=member(Join|Leave)/);
    // A thrown handler would also replace the message with its error (and degrade after three).
    assert.equal(status.message, baseline.message, JSON.stringify(status));
    assert.equal(status.health, "Healthy", JSON.stringify(status));

    const trigger = await sim.command(sim.owner, "reporttest");
    assert.equal(trigger.status, "replied", JSON.stringify(trigger));
    const staff = sim.guild.channels.find((c) => c.name === "reports");
    const card = (await sim.api("/api/v1/sim/channels/" + staff.id + "/messages")).items
      .filter((m) => m.author.bot && m.embeds?.length)
      .map((m) => m.embeds[0])[0];
    assert.ok(card, sim.logs());
    assert.match(card.description, /Départs sous 7 jours : 1 sur 1 arrivées/);
    assert.equal((await instance()).message, baseline.message);
  },
);
