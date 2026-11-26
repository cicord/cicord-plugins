import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { startSimulator } from "../../../scripts/simulator.mjs";
const dir = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
test(
  "replaying the production weekly and monthly report handlers posts one of each to staff",
  { timeout: 45000 },
  async (t) => {
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
      ],
      { staffChannel: "reports" },
      {
        health: ["Healthy", "Degraded"],
        async prepare({ repo, pluginDir }) {
          const server = join(repo, "servers/acceptance.yaml");
          const yaml = await readFile(server, "utf8");
          await writeFile(
            server,
            yaml.replace(
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
          // Trigger the unmodified production report handler twice without waiting for its hourly cron.
          await writeFile(
            join(pluginDir, "src/test-clock.ts"),
            `import {definePlugin} from "@cicord/sdk";import plugin from "./index.ts";
 export default definePlugin({...plugin,onStart:async ctx=>{await ctx.schedule.after(1000,"trigger",null);},tasks:{...plugin.tasks,async trigger(ctx){await plugin.schedules.reports.run(ctx);await plugin.schedules.reports.run(ctx);}}});`,
          );
        },
      },
    );
    const staff = sim.guild.channels.find((c) => c.name === "reports");
    assert.ok(staff);
    let sent = [];
    for (let step = 0; step < 60; step++) {
      sent = (await sim.api("/api/v1/sim/channels/" + staff.id + "/messages")).items;
      if (sent.length >= 2) break;
      await delay(200);
    }
    assert.equal(sent.length, 2, sim.logs());
    assert.deepEqual([...new Set(sent.map((m) => m.embeds[0].title.split(" · ")[1]))].sort(), [
      "month",
      "week",
    ]);
    for (const m of sent)
      assert.match(m.embeds[0].description, /Short-stay departures unavailable/);
  },
);
