import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { startSimulator } from "../../../scripts/simulator.mjs";
const dir = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
test(
  "gateway joins without an invite remain unattributed; leaderboard access needs membership",
  { timeout: 45000 },
  async (t) => {
    const sim = await startSimulator(
      t,
      dir,
      ["discord.invites.read", "scheduler", "storage.kv", "events.publish", "portal.routes"],
      { minAccountDays: 0 },
    );
    const alice = sim.users.find((u) => u.username === "alice");
    await sim.join(alice);
    const route = "/api/v1/portal/acceptance/plugins/bot/invite-tracker/leaderboard";
    await assert.rejects(sim.api(route), /401/);
    assert.deepEqual(await sim.api(route, undefined, await sim.login(alice)), []);
    const count = await sim.command(alice, "invites");
    assert.match(JSON.stringify(count), /0 valid/);
    const auth = "local-simulator-only";
    for (let n = 0; n < 40; n++) {
      const report = await sim.api(
        "/api/v1/servers/acceptance/privacy/export",
        { userId: alice.id },
        auth,
      );
      const item = report.plugins.find(
        (p) => p.instance.endsWith("invite-tracker") || p.instance.includes("/invite-tracker"),
      );
      const entry = item?.data?.find((e) => e.id === alice.id);
      if (entry) {
        assert.equal(entry.entry.inviterId, undefined);
        assert.equal(entry.entry.code, undefined);
        assert.equal(entry.entry.left, false);
        return;
      }
      await delay(100);
    }
    assert.fail("member join never appeared in the plugin privacy export");
  },
);

test(
  "legacy inviter records are indexed by durable scheduler jobs in the actual runtime",
  { timeout: 45000 },
  async (t) => {
    const sim = await startSimulator(
      t,
      dir,
      ["discord.invites.read", "scheduler", "storage.kv", "events.publish", "portal.routes"],
      {},
      {
        async prepare({ pluginDir }) {
          const manifest = join(pluginDir, "plugin.yaml");
          await writeFile(
            manifest,
            (await readFile(manifest, "utf8")).replace(
              "entry: ./src/index.ts",
              "entry: ./src/legacy-fixture.ts",
            ),
          );
          await writeFile(
            join(pluginDir, "src/legacy-fixture.ts"),
            `import {definePlugin} from "@cicord/sdk";import plugin from "./index.ts";
   export default definePlugin({...plugin,async onStart(ctx){
    const batch=ctx.kv.atomic();for(let i=0;i<80;i++)batch.set("member:"+String(2000+i),{inviterId:String(3000+i%20),at:1,left:false,fake:false});await batch.commit();
    await plugin.onStart(ctx);
   }});`,
          );
        },
      },
    );
    const token = await sim.login(sim.owner),
      route = "/api/v1/portal/acceptance/plugins/bot/invite-tracker/leaderboard";
    let first;
    for (let i = 0; i < 80; i++) {
      try {
        first = await sim.api(route + "?limit=3", undefined, token);
        break;
      } catch (err) {
        if (!String(err).includes("503")) throw err;
      }
      await delay(100);
    }
    assert.deepEqual(
      first,
      ["3000", "3001", "3002"].map((userId) => ({ userId, valid: 4, fake: 0, left: 0 })),
    );
    const second = await sim.api(route + "?limit=2&offset=3", undefined, token);
    assert.deepEqual(
      second.map((x) => x.userId),
      ["3003", "3004"],
    );
  },
);
