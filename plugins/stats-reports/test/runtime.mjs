import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { startSimulator } from "../../../scripts/simulator.mjs";
const dir = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import french from "../locales/fr.json" with { type: "json" };
test(
  "weekly and monthly staff posts match the Analytics panel on the same populated data",
  { timeout: 100000 },
  async (t) => {
    const today = new Date(),
      midnight = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
    const DAY = 86400000,
      weekStart = midnight - ((today.getUTCDay() + 6) % 7) * DAY;
    const periods = [
      { word: "semaine", from: weekStart, to: weekStart + 7 * DAY },
      {
        word: "mois",
        from: Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1),
        to: Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1),
      },
    ];
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
      { staffChannel: "reports", locale: "fr" },
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
          // Close this real observation period at the next calendar boundary without waiting a week or month.
          await writeFile(
            join(pluginDir, "src/test-clock.ts"),
            `import {command,definePlugin} from "@cicord/sdk";import plugin,{publish} from "./index.ts";
 export default definePlugin({...plugin,commands:{...plugin.commands,reporttest:command({description:"Run reports in this disposable fixture",async run(ctx,it){for(let attempt=0;attempt<2;attempt++){await publish(ctx,"week",${periods[0].to});await publish(ctx,"month",${periods[1].to});}await it.reply({content:"done",ephemeral:true});}})}});`,
          );
        },
      },
    );
    const staff = sim.guild.channels.find((c) => c.name === "reports");
    assert.ok(staff);
    const auth = "local-simulator-only",
      base = "/api/v1/servers/acceptance/analytics/";
    const alice = sim.users.find((u) => u.username === "alice");
    await sim.join(alice);
    for (let i = 0; i < 7; i++)
      await sim.api("/api/v1/sim/messages", {
        channelId: sim.channel.id,
        userId: alice.id,
        content: "panel fixture " + i,
      });
    // Staff messages enter the aggregate but their channel must never appear in the public ranking.
    await sim.api("/api/v1/sim/messages", {
      channelId: staff.id,
      userId: sim.owner.id,
      content: "private staff observation",
    });
    const query = (p) =>
      new URLSearchParams({
        from: new Date(p.from).toISOString(),
        to: new Date(p.to).toISOString(),
      });
    let ready = false;
    for (let n = 0; n < 80; n++) {
      const panel = await sim.api(base + "summary?" + query(periods[0]), undefined, auth);
      if (panel.kpis.find((x) => x.metric === "messages.sent")?.value >= 8) {
        ready = true;
        break;
      }
      await delay(500);
    }
    assert.ok(ready, "collector must flush the real simulated messages before comparing panels");
    const trigger = await sim.command(sim.owner, "reporttest");
    assert.equal(trigger.status, "replied", JSON.stringify(trigger));
    const sent = (await sim.api("/api/v1/sim/channels/" + staff.id + "/messages")).items.filter(
      (m) => m.embeds?.length && m.author.bot,
    );
    assert.equal(sent.length, 2, sim.logs());
    for (const { word, from, to } of periods) {
      const card = sent.map((m) => m.embeds[0]).find((e) => e.title.includes(" · " + word + " · "));
      assert.ok(card);
      assert.match(card.title, /^Activité/);
      assert.match(card.description, /Départs sous 7 jours indisponibles/);
      const q = new URLSearchParams({
        from: new Date(from).toISOString(),
        to: new Date(to).toISOString(),
      });

      const panel = await sim.api(base + "summary?" + q, undefined, auth);
      const metrics = [
        "members.total",
        "members.joined",
        "members.left",
        "members.active",
        "messages.sent",
        "voice.seconds",
        "moderation.actions",
        "members.online",
      ];
      const lines = card.description.split("\n");
      for (const metric of metrics) {
        const kpi = panel.kpis.find((k) => k.metric === metric);
        assert.ok(kpi, metric);
        assert.ok(lines.includes(french[metric] + ": " + kpi.value), metric + " in " + word);
      }
      const series = await sim.api(
        base + "series?" + q + "&metrics=invites.uses,members.boosting&step=day",
        undefined,
        auth,
      );
      const invites = series.series
        .find((s) => s.metric === "invites.uses" && s.dim === "")
        .points.reduce((n, p) => n + p[1], 0);
      const boosts =
        series.series
          .find((s) => s.metric === "members.boosting" && s.dim === "")
          .points.at(-1)?.[1] ?? 0;
      assert.ok(lines.includes(french["invites.uses"] + ": " + invites));
      assert.ok(lines.includes(french["members.boosting"] + ": " + boosts));
      const publicMessages = panel.rankings["messages.sent"].find(
        (row) => row.dim === sim.channel.id,
      );
      assert.ok(lines.includes("general: " + publicMessages.value));
      assert.ok(!lines.some((l) => l.startsWith("reports:")));
      let peak = 0,
        when = "";
      panel.heatmap.forEach((row, d) =>
        row.forEach((v, h) => {
          if (v > peak) {
            peak = v;
            when = french["weekday" + d] + " " + String(h).padStart(2, "0") + ":00 UTC";
          }
        }),
      );
      assert.ok(
        lines.includes(french.peak.replace("{when}", when).replace("{best}", String(peak))),
        card.description,
      );
    }
  },
);
