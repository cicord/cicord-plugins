import assert from "node:assert/strict";
import test from "node:test";
import { appendFile, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { startSimulator } from "../../../scripts/simulator.mjs";

const dir = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
// The real tickets.open contract, so the runtime validates economy's input as in production.
const contract = fileURLToPath(new URL("../../tickets/contracts/open.v1.json", import.meta.url));
const grants = [
  "storage.kv",
  "discord.messages.send",
  "portal.routes",
  "events.publish",
  "scheduler",
  "plugins.call:tickets.open",
];
const config = {
  enabled: true,
  daily: 100,
  shop: [
    { id: "vip", label: "VIP", price: 30, type: "perk" },
    { id: "refused", label: "Refused", price: 10, type: "perk" },
    { id: "flaky", label: "Flaky", price: 10, type: "perk" },
  ],
};

// A provider named `tickets` that, like the real one, refuses calls without a member
// principal. It posts one line per call (a real effect, so it survives a failed action):
// the key, the subject and the principal it received. "Refused" is a policy refusal;
// "Flaky" fails as a handler error until /probe-heal.
async function prepare({ repo, pluginDir }) {
  const probe = join(repo, "plugins", "tickets");
  await mkdir(join(probe, "src"), { recursive: true });
  await mkdir(join(probe, "contracts"), { recursive: true });
  await copyFile(contract, join(probe, "contracts", "open.v1.json"));
  await writeFile(
    join(probe, "plugin.yaml"),
    `apiVersion: cicord.dev/v1alpha1
kind: Plugin
metadata: {name: tickets, version: 0.1.0, license: Apache-2.0}
spec:
  engine: ">=0.2.0"
  entry: ./src/index.ts
  delivery: at-least-once
  capabilities:
    - storage.kv # probe state
    - discord.messages.send # call log
    - discord.channels.read # call log channel
  interop:
    provides: {actions: [open]}
`,
  );
  await writeFile(
    join(probe, "src/index.ts"),
    `import {action, command, definePlugin, InteropError} from "@cicord/sdk";
export default definePlugin({
  commands: {"probe-heal": command({description: "heal", async run(ctx, i) { await ctx.kv.set("healed", true); await i.reply("healed"); }})},
  actions: {open: action({async run(ctx, input, call) {
    const data = input as {userId: string; subject: string};
    await ctx.server.channel("general").send("probe-call " + JSON.stringify({key: call.idempotencyKey, subject: data.subject, userId: data.userId, principal: call.onBehalfOf?.userId ?? null}));
    if (!call.onBehalfOf) throw new Error("Ticket author required");
    if (data.subject === "Refused") throw new InteropError("denied", "refused by policy");
    if (data.subject === "Flaky" && !(await ctx.kv.get("healed"))) throw new Error("temporarily unavailable");
    return {id: "1"};
  }})},
});
`,
  );
  await appendFile(
    join(repo, "bots", "bot", "bot.yaml"),
    `    - name: tickets
      source: ../../plugins/tickets
      grants: ["storage.kv", "discord.messages.send", "discord.channels.read"]
      config: {}
`,
  );
  // Economy as shipped, plus fixture commands to run the hourly pass as a background task
  // and to count the fulfill tasks it ran.
  const manifest = join(pluginDir, "plugin.yaml");
  await writeFile(
    manifest,
    (await readFile(manifest, "utf8")).replace("entry: ./src/index.ts", "entry: ./src/fixture.ts"),
  );
  await writeFile(
    join(pluginDir, "src/fixture.ts"),
    `import {command, definePlugin} from "@cicord/sdk";
import economy from "./index.ts";
const fulfill = economy.tasks!.fulfill!;
export default definePlugin({...economy,
  commands: {...economy.commands,
    "fixture-cron": command({description: "cron", async run(ctx, i) { await ctx.schedule.after(1, "pending"); await i.reply("queued"); }}),
    "fixture-fulfilled": command({description: "count", async run(ctx, i) { await i.reply(String((await ctx.kv.get("fixture:fulfilled")) ?? 0)); }}),
  },
  tasks: {...economy.tasks, async fulfill(ctx, p) { await fulfill(ctx, p); await ctx.kv.increment("fixture:fulfilled"); }},
});
`,
  );
}

test(
  "perks are delivered from /buy and the portal with the buyer as principal; refusals refund; failures wait for the member",
  { timeout: 180000 },
  async (t) => {
    const sim = await startSimulator(t, dir, grants, config, {
      prepare,
      health: ["Healthy", "Degraded"],
    });
    const alice = sim.users.find((u) => u.username === "alice");
    await sim.join(alice);
    const token = await sim.login(alice);
    const base = "/api/v1/portal/acceptance/plugins/bot/economy";
    const wallet = async () => (await sim.api(base + "/wallet", undefined, token)).balance;
    const reply = async (name, options) =>
      (await sim.command(alice, name, options)).response?.content ?? "";
    const calls = async () => {
      const { items } = await sim.api(
        "/api/v1/sim/channels/" + sim.channel.id + "/messages?limit=100",
      );
      return items
        .map((m) => m.content ?? "")
        .filter((c) => c.startsWith("probe-call "))
        .map((c) => JSON.parse(c.slice("probe-call ".length)));
    };
    await reply("daily");
    assert.equal(await wallet(), 100);

    // Delivered inside /buy: the provider saw alice as principal and the order key.
    assert.equal(await reply("buy", { item: "vip" }), "Purchase delivered: vip.", sim.logs());
    let seen = await calls();
    assert.equal(seen.length, 1);
    assert.equal(seen[0].principal, alice.id);
    assert.match(seen[0].key, /^order:\d+$/);

    // Delivered inside the portal route, with the same guarantees.
    const purchaseId = "cdfad0ee-53c9-45eb-a106-d522cc34ccf6";
    const bought = await sim.api(base + "/shop/vip/buy", { purchaseId }, token);
    assert.equal(bought.state, "delivered");
    seen = await calls();
    assert.equal(seen.at(-1).key, "order:portal:" + alice.id + ":" + purchaseId);
    assert.equal(seen.at(-1).principal, alice.id);
    assert.equal(await wallet(), 40);

    // A definitive refusal is refunded at once.
    assert.equal(
      await reply("buy", { item: "refused" }),
      "refused could not be delivered. Your points were refunded.",
    );
    assert.equal(await wallet(), 40);

    // An ambiguous failure keeps the order pending and the points charged.
    assert.match(await reply("buy", { item: "flaky" }), /^Payment recorded for flaky.*72 hours\.$/);
    assert.equal(await wallet(), 30);

    // The background pass runs without a principal and must not call tickets.open.
    await reply("fixture-cron");
    for (let n = 0; n < 100 && (await reply("fixture-fulfilled")) === "0"; n++) await delay(100);
    assert.notEqual(await reply("fixture-fulfilled"), "0");
    seen = await calls();
    assert.equal(seen.filter((c) => c.principal === null).length, 0, JSON.stringify(seen));
    assert.equal(seen.filter((c) => c.subject === "Flaky").length, 1);
    assert.equal(await wallet(), 30);

    // The member retries from /inventory with the original key and gets the perk.
    assert.equal((await sim.command(alice, "probe-heal")).status, "replied");
    assert.match(await reply("inventory"), /Flaky · delivered/);
    const flaky = (await calls()).filter((c) => c.subject === "Flaky");
    assert.equal(flaky.length, 2);
    assert.equal(flaky[0].key, flaky[1].key);
    assert.equal(flaky[1].principal, alice.id);
    assert.equal(await wallet(), 30);
    assert.doesNotMatch(sim.logs(), /invalid_input/);
  },
);
