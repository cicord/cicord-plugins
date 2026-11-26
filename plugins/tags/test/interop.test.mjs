import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { startSimulator } from "../../../scripts/simulator.mjs";

// Provider queries run in a fresh JS realm that never ran onStart. A consumer plugin
// calls tags.search through the real interop path (contract validation, onBehalfOf from
// the portal viewer) and must see the same catalog as the tags plugin's own routes.
async function prepare({ repo }) {
  const server = join(repo, "servers/acceptance.yaml");
  await writeFile(
    server,
    (await readFile(server, "utf8")).replace(
      "  channels:\n",
      `  channels:
    staff:
      name: staff
      type: text
      overwrites:
        "@everyone": {deny: [ViewChannel, ReadMessageHistory]}
        moderator: {allow: [ViewChannel, ReadMessageHistory]}
`,
    ),
  );
  const probe = join(repo, "plugins", "probe");
  await mkdir(join(probe, "src"), { recursive: true });
  await writeFile(
    join(probe, "plugin.yaml"),
    `apiVersion: cicord.dev/v1alpha1
kind: Plugin
metadata: {name: probe, version: 0.1.0, license: Apache-2.0}
spec:
  engine: ">=0.2.0"
  entry: ./src/index.ts
  delivery: at-least-once
  capabilities:
    - portal.routes # probe route
    - plugins.query:tags.search # consumer under test
  interop:
    consumes: {queries: [tags.search]}
`,
  );
  await writeFile(
    join(probe, "src/index.ts"),
    `import {definePlugin} from "@cicord/sdk";
export default definePlugin({routes:{"GET /probe":{access:"member",async handler(ctx,req){
  return {has: ctx.plugins.has("tags"), result: await ctx.plugins.query("tags","search",{query:req.query.q ?? "",limit:10})};
}}}});
`,
  );
  const bot = join(repo, "bots/bot/bot.yaml");
  const yaml = await readFile(bot, "utf8");
  await writeFile(
    bot,
    yaml.replace(
      /(\n    - name: tags\n)/,
      `\n    - name: probe\n      source: ../../plugins/probe\n      grants: ["portal.routes","plugins.query:tags.search"]\n      config: {}$1`,
    ),
  );
}

test("tags.search over interop returns file and portal tags, filtered by onBehalfOf", { timeout: 120000 }, async (t) => {
  const dir = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
  const sim = await startSimulator(
    t,
    dir,
    [
      "storage.kv",
      "discord.messages.send",
      "discord.channels.read",
      "discord.members.read",
      "portal.routes",
      "files.read",
    ],
    { enabled: true, editableOnPortal: true },
    {
      health: ["Healthy", "Degraded"],
      instance: { files: ["tags/**/*.md"] },
      files: {
        "tags/reset.md": "---\nname: Reset desk\naliases: [restart]\n---\nRestart the desk application.",
      },
      prepare,
    },
  );
  const alice = sim.users.find((u) => u.username === "alice");
  await sim.join(alice);
  const owner = await sim.login(sim.owner),
    member = await sim.login(alice);
  const tags = "/api/v1/portal/acceptance/plugins/bot/tags/tags";
  const probe = (token, q) =>
    sim.api("/api/v1/portal/acceptance/plugins/bot/probe/probe?q=" + q, undefined, token);
  const desk = { name: "Desk", text: "Contact the help desk.", aliases: [], keywords: [] };
  const staff = {
    name: "Desk escalation",
    text: "Page the on-call desk lead.",
    aliases: [],
    keywords: [],
    channel: "staff",
  };
  assert.equal((await sim.api(tags + "/Desk", desk, owner, "PUT")).saved, true);
  assert.equal((await sim.api(tags + "/Desk%20escalation", staff, owner, "PUT")).saved, true);

  const own = await sim.api(tags + "?q=desk", undefined, owner);
  const names = (r) => r.entries.map((e) => e.name).sort();
  assert.deepEqual(names(own), ["Desk", "Desk escalation", "Reset desk"]);

  const asOwner = await probe(owner, "desk");
  assert.equal(asOwner.has, true);
  assert.deepEqual(names(asOwner.result), ["Desk", "Desk escalation", "Reset desk"]);

  // Alice cannot read #staff: the restricted tag is withheld from her principal.
  const asMember = await probe(member, "desk");
  assert.deepEqual(names(asMember.result), ["Desk", "Reset desk"]);

  // A portal deletion is visible to the next provider call (no stale realm state).
  assert.equal((await sim.api(tags + "/Desk", undefined, owner, "DELETE")).deleted, true);
  assert.deepEqual(names((await probe(owner, "desk")).result), ["Desk escalation", "Reset desk"]);
});
