import assert from "node:assert/strict";
import { cp, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { startSimulator } from "./simulator.mjs";

const plugins = fileURLToPath(new URL("../plugins/", import.meta.url));
test(
  "all registry plugins accept enabled:false alone with no grants, resources or executable handlers",
  { timeout: 120000 },
  async (t) => {
    const dirs = (await readdir(plugins, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    assert.ok(dirs.includes("levels") && dirs.includes("tickets"));
    const first = dirs[0];
    const sim = await startSimulator(
      t,
      join(plugins, first),
      [],
      { enabled: false },
      {
        health: "Disabled",
        async prepare({ repo }) {
          const botFile = join(repo, "bots/bot/bot.yaml");
          // This is a normal project load. Individual enabled-case simulator fixtures
          // and their synthetic private channels have no place in this installation.
          const original = await readFile(botFile, "utf8");
          const marker = '      config: {"enabled":false}';
          assert.equal(original.split(marker).length, 2);
          const entries = [];
          for (const name of dirs.slice(1)) {
            await cp(join(plugins, name), join(repo, "plugins", name), {
              recursive: true,
              filter: (path) =>
                !["test", ".cicord", "node_modules", ".git"].includes(basename(path)),
            });
            entries.push(
              "    - name: " +
                name +
                "\n      source: ../../plugins/" +
                name +
                "\n      grants: []\n      config: {enabled: false}",
            );
          }
          await writeFile(botFile, original.replace(marker, marker + "\n" + entries.join("\n")));
        },
      },
    );
    const status = await sim.api("/api/v1/status", undefined, "local-simulator-only");
    const instances = status.bots.flatMap((b) => b.plugins);
    assert.deepEqual(instances.map((p) => p.instance).sort(), dirs);
    assert.ok(
      instances.every((p) => p.health === "Disabled"),
      JSON.stringify(instances),
    );
    const result = await sim.api("/api/v1/sim/commands?serverId=" + sim.guild.id);
    assert.equal(
      (result.items ?? result.commands ?? result).length,
      0,
      "Disabled instances registered Discord commands",
    );
    await assert.rejects(
      sim.api("/api/v1/portal/acceptance/plugins/bot/levels/leaderboard"),
      /404/,
    );
    t.diagnostic(
      dirs.length +
        " disabled installations validated together without optional grants or channels.",
    );
  },
);
