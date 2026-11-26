import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { startSimulator } from "../../../scripts/simulator.mjs";

const grants = [
  "discord.messages.send",
  "discord.reactions.manage",
  "discord.channels.read",
  "discord.members.read",
  "discord.roles.assign",
  "storage.kv",
  "scheduler",
  "portal.routes",
  "portal.links",
  "events.subscribe",
  "events.publish",
  "plugins.query:polls.voters",
  "render",
  "files.read",
];

// Only the disposable fixture gains a seeding task. Every measured interaction is the
// production /rank command, resolved by the normal server and run through QuickJS.
async function prepare({ pluginDir }) {
  const manifest = join(pluginDir, "plugin.yaml");
  await writeFile(
    manifest,
    (await readFile(manifest, "utf8")).replace(
      "entry: ./src/index.ts",
      "entry: ./src/benchmark.ts",
    ),
  );
  await writeFile(
    join(pluginDir, "src/benchmark.ts"),
    `
    import {definePlugin} from "@cicord/sdk";
    import levels from "./index.ts";
    export default definePlugin({...levels,
      async onStart(ctx){await levels.onStart(ctx);await ctx.schedule.after(1,"seed",0);},
      tasks:{...levels.tasks,async seed(ctx,start){
        for(let n=start;n<Math.min(100000,start+2000);n+=100){
          const batch=ctx.kv.atomic();
          for(let i=n;i<n+100;i++)batch.rankSet("xp",i===1?ctx.server.ownerId:String(1000000000+i),100000-i);
          await batch.commit();
        }
        if(start+2000<100000)await ctx.schedule.after(1,"seed",start+2000);
      }},
      routes:{...levels.routes,"GET /fixture":{access:"moderator",async handler(ctx){return {size:await ctx.kv.ranking("xp").count(),schema:await ctx.kv.get("meta:schema")};}}}
    });
  `,
  );
}
test("simulated Discord /rank on 100,000 ranked members", { timeout: 300000 }, async (t) => {
  const dir = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
  const sim = await startSimulator(
    t,
    dir,
    grants,
    {},
    { prepare, health: ["Healthy", "Degraded"] },
  );
  const token = await sim.login(sim.owner);
  let status;
  for (let attempt = 0; attempt < 400; attempt++) {
    status = await sim.api(
      "/api/v1/portal/acceptance/plugins/bot/levels/fixture",
      undefined,
      token,
    );
    if (status.size === 100000 && status.schema === 2) break;
    await delay(500);
  }
  assert.deepEqual(status, { size: 100000, schema: 2 });
  const timings = [];
  for (let i = 0; i < 30; i++) {
    const start = performance.now();
    const result = await sim.command(sim.owner, "rank");
    timings.push(performance.now() - start);
    assert.equal(result.status, "replied", JSON.stringify(result));
    assert.match(result.response.content, /rank #2 of 100000/);
  }
  const p95 = timings.toSorted((a, b) => a - b)[Math.ceil(0.95 * timings.length) - 1];
  t.diagnostic(
    `/rank n=30, 100000 members, local simulated Discord request to complete reply, p95 ${p95.toFixed(2)} ms`,
  );
  assert.ok(p95 < 1000, `p95 exceeded one second: ${p95} ms`);
});
