import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { startSimulator } from "../../../scripts/simulator.mjs";

const grants = [
  "discord.messages.send",
  "discord.messages.read",
  "discord.channels.read",
  "discord.auditlog.read",
  "storage.kv",
  "scheduler",
  "portal.routes",
  "events.subscribe",
  "storage.index",
  "discord.messages.manage",
];
// This disposable test fixture adds a moderator action. Production audit-log
// only observes the resulting normal gateway, REST and task deliveries.
async function prepare({ repo, pluginDir }) {
  const server = join(repo, "servers", "acceptance.yaml");
  await writeFile(
    server,
    (await readFile(server, "utf8")).replace(
      "  channels:\n",
      `  channels:
    audit:
      name: audit
      type: text
      category: community
      overwrites:
        "@everyone": {deny: [ViewChannel, ReadMessageHistory]}
        moderator: {allow: [ViewChannel, ReadMessageHistory]}
`,
    ),
  );
  const path = join(pluginDir, "plugin.yaml");
  await writeFile(
    path,
    (await readFile(path, "utf8"))
      .replace("entry: ./src/index.ts", "entry: ./src/fixture.ts")
      .replace("  capabilities:\n", "  capabilities:\n    - discord.messages.manage\n"),
  );
  await writeFile(
    join(pluginDir, "src/fixture.ts"),
    `
 import {definePlugin} from "@cicord/sdk";import plugin from "./index.ts";
 export default definePlugin({...plugin,routes:{...plugin.routes,
 "POST /fixture/delete":{access:"admin",async handler(ctx,{body}){
 const ch=ctx.server.channel("general");
 const msg=body.bot?await ch.send("self deleted fixture"):await ch.message(body.id);
 if(!msg)throw Error("fixture message not found");
 await msg.delete("test moderation");return {id:msg.id};
 }}
 }});
 `,
  );
}
test(
  "Discord deletion evidence, REST count and missing evidence reach their staff log deadlines",
  { timeout: 90_000 },
  async (t) => {
    const plugin = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
    const sim = await startSimulator(
      t,
      plugin,
      grants,
      { channel: "audit", cacheContent: true, batchSeconds: 10, ignoreBots: false },
      { prepare },
    );
    const channel = sim.guild.channels.find((c) => c.name === "audit");
    assert.ok(channel);
    const alice = sim.users.find((u) => u.username === "alice");
    assert.ok(alice);
    await sim.join(alice);
    const token = await sim.login(sim.owner);
    const route = "/api/v1/portal/acceptance/plugins/bot/audit-log";
    async function waitFor(text, timeout) {
      const start = performance.now();
      while (performance.now() - start < timeout) {
        const { items } = await sim.api(
          "/api/v1/sim/channels/" + channel.id + "/messages?limit=100",
        );
        if (items.some((m) => m.embeds?.some((e) => e.description?.includes(text))))
          return performance.now() - start;
        await delay(40);
      }
      throw Error("Timed out awaiting " + text);
    }
    async function moderatorDelete() {
      const msg = await sim.api("/api/v1/sim/messages", {
        userId: alice.id,
        channelId: sim.channel.id,
        content: "private-canary-18372",
      });
      await sim.api(route + "/fixture/delete", { id: msg.id }, token);
    }
    await moderatorDelete();
    const confirmed = await waitFor("Confirmed audit entry", 10_000);
    await moderatorDelete();
    const probable = await waitFor("Probable attribution", 10_000);
    const before = performance.now();
    await sim.api(route + "/fixture/delete", { bot: true }, token);
    await waitFor("actor unknown", 35_000);
    const unknown = performance.now() - before;
    assert.ok(unknown >= 29_000 && unknown < 36_000, `unknown deadline ${unknown}ms`);
    const log = await sim.api("/api/v1/sim/channels/" + channel.id + "/messages");
    assert.doesNotMatch(JSON.stringify(log), /private-canary-18372/);
    t.diagnostic(
      `One local simulated server, two deletion samples measured from the moderator API response to observed log. First ${confirmed.toFixed(0)} ms, merged ${probable.toFixed(0)} ms. Self deletion to unknown ${unknown.toFixed(0)} ms.`,
    );
  },
);
