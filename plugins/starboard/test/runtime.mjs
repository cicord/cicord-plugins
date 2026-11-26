import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { startSimulator } from "../../../scripts/simulator.mjs";

// Only the fixture receives a reaction command. The production plugin consumes the
// actual Discord gateway events and the real message/reaction/audience host methods.
async function prepare({ repo, pluginDir }) {
  const server = join(repo, "servers/acceptance.yaml");
  await writeFile(
    server,
    (await readFile(server, "utf8")).replace(
      "  channels:\n",
      `  channels:
    stars:
      name: stars
      type: text
    staff:
      name: staff
      type: text
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
      .replace(
        "  capabilities:\n",
        "  capabilities:\n    - discord.reactions.manage\n    - portal.routes\n",
      ),
  );
  await writeFile(
    join(pluginDir, "src/fixture.ts"),
    `
    import {definePlugin} from "@cicord/sdk";import original from "./index.ts";
    export default definePlugin({...original,routes:{"POST /fixture/react":{access:"admin",async handler(ctx,r){
      const c=ctx.server.channel({id:r.body.channel}),m=await c.message(r.body.id);
      if(!m)throw Error("fixture message absent");
      if(r.body.remove)await m.removeReaction("⭐");else await m.react("⭐");return {ok:true};
    }}}});`,
  );
}
test(
  "a real star posts once, private content stays private and removing the reaction withdraws the highlight",
  { timeout: 65000 },
  async (t) => {
    const dir = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
    const sim = await startSimulator(
      t,
      dir,
      [
        "storage.kv",
        "scheduler",
        "discord.messages.send",
        "discord.messages.read",
        "discord.messages.manage",
        "discord.channels.read",
        "events.publish",
        "discord.reactions.manage",
        "portal.routes",
      ],
      { channel: "stars", boards: [{ sources: ["staff"], channel: "stars" }], threshold: 1 },
      { prepare },
    );
    const alice = sim.users.find((u) => u.username === "alice");
    await sim.join(alice);
    const staff = sim.guild.channels.find((c) => c.name === "staff"),
      stars = sim.guild.channels.find((c) => c.name === "stars"),
      token = await sim.login(sim.owner);
    const post = (as, channel, content) =>
      sim.api("/api/v1/sim/messages", { userId: as.id, channelId: channel.id, content });
    const react = (m, remove = false) =>
      sim.api(
        "/api/v1/portal/acceptance/plugins/bot/starboard/fixture/react",
        { channel: m.channelId, id: m.id, remove },
        token,
      );
    const highlights = async () =>
      (await sim.api("/api/v1/sim/channels/" + stars.id + "/messages")).items.filter(
        (m) => m.embeds.length,
      );
    const wait = async (predicate) => {
      for (let n = 0; n < 100; n++) {
        const rows = await highlights();
        if (predicate(rows)) return rows;
        await delay(200);
      }
      throw Error("Highlight change timed out");
    };
    await assert.rejects(post(alice, staff, "cannot send"), /403/);
    const secret = await post(sim.owner, staff, "Staff review details"),
      publicMessage = await post(alice, sim.channel, "Summer festival");
    await react(secret);
    await react(publicMessage);
    await react(publicMessage);
    const rows = await wait((ms) => ms.some((m) => m.embeds[0]?.description === "Summer festival"));
    assert.equal(rows.length, 1);
    assert.ok(!JSON.stringify(rows).includes("Staff review details"));
    const top = await sim.command(alice, "starboard top");
    assert.equal(top.status, "replied");
    assert.ok(top.response.content.includes(rows[0].id));
    await react(publicMessage, true);
    await wait((ms) => ms.length === 0);
  },
);

test(
  "erasing the author during the coalescing window keeps the highlight from being published",
  { timeout: 65000 },
  async (t) => {
    const dir = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
    const sim = await startSimulator(
      t,
      dir,
      [
        "storage.kv",
        "scheduler",
        "discord.messages.send",
        "discord.messages.read",
        "discord.messages.manage",
        "discord.channels.read",
        "events.publish",
        "discord.reactions.manage",
        "portal.routes",
      ],
      { channel: "stars", threshold: 1 },
      { prepare },
    );
    const alice = sim.users.find((u) => u.username === "alice");
    await sim.join(alice);
    const stars = sim.guild.channels.find((c) => c.name === "stars"),
      token = await sim.login(sim.owner);
    const message = await sim.api("/api/v1/sim/messages", {
      userId: alice.id,
      channelId: sim.channel.id,
      content: "Alice's summer photo",
    });
    await sim.api(
      "/api/v1/portal/acceptance/plugins/bot/starboard/fixture/react",
      { channel: message.channelId, id: message.id },
      token,
    );
    // The reaction event carries a partial message: the pending row has no author yet.
    await delay(500);
    const erased = await sim.api(
      "/api/v1/servers/acceptance/privacy/erase",
      { userId: alice.id },
      "local-simulator-only",
    );
    t.diagnostic(JSON.stringify(erased));
    await delay(12000);
    const rows = (await sim.api("/api/v1/sim/channels/" + stars.id + "/messages")).items;
    assert.equal(
      rows.filter((m) => m.embeds.length).length,
      0,
      "an erased member's message was highlighted",
    );
  },
);
