import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { startSimulator } from "../../../scripts/simulator.mjs";

const dir = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const grants = [
  "discord.messages.send",
  "discord.messages.read",
  "discord.messages.manage",
  "discord.channels.read",
  "discord.channels.manage",
  "discord.members.read",
  "discord.dm.send",
  "storage.kv",
  "portal.routes",
  "portal.links",
  "events.publish",
  "scheduler",
];
const secondID = "100000000000000099";
async function prepare({repo}) {
  const bot = join(repo, "bots/bot/bot.yaml"),
    server = join(repo, "servers/acceptance.yaml");
  const yaml = (await readFile(server, "utf8")).replace(
    "  channels:\n",
    `  channels:
    private-log:
      name: private-log
      type: text
      category: community
      overwrites:
        "@everyone": {deny: [ViewChannel]}
        moderator: {allow: [ViewChannel,ReadMessageHistory]}
`,
  );
  await writeFile(server, yaml);
  await writeFile(
    join(repo, "servers/secondary.yaml"),
    yaml
      .replace("name: acceptance", "name: secondary")
      .replace(/discordId: "\d+"/, 'discordId: "' + secondID + '"'),
  );
  const contents = await readFile(bot, "utf8");
  await writeFile(
    bot,
    contents.replace(
      "servers: [acceptance]",
      "servers: [acceptance, secondary]\n  directMessages: {instance: tickets}",
    ) +
      "\n    - name: fixtures\n      source: ../../plugins/fixtures\n      grants: [discord.members.read, discord.roles.assign, discord.dm.send, discord.channels.read, discord.messages.read, plugins.call:tickets.open]\n",
  );
  const root = join(repo, "plugins/fixtures");
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(
    join(root, "plugin.yaml"),
    "apiVersion: cicord.dev/v1alpha1\nkind: Plugin\nmetadata: {name: fixtures, version: 0.1.0}\nspec: {entry: ./src/index.ts, engine: '>=0.2.0', intents: [MessageContent], delivery: at-least-once, interop: {consumes: {actions: [tickets.open]}}, capabilities: [discord.members.read, discord.roles.assign, discord.dm.send, discord.channels.read, discord.messages.read, plugins.call:tickets.open]}\n",
  );
  // Drive real Discord role changes from a disposable operator command. Opening the
  // initial DM supplies its bot/user channel ID to the simulator's POST /sim/messages.
  await writeFile(
    join(root, "src/index.ts"),
    `import {command,definePlugin} from "@cicord/sdk";
    export default definePlugin({commands:{
      "fixture-role":command({description:"Adjust an integration test role",permissions:["ManageRoles"],options:{
          user:{type:"user",required:true,description:"Member"},
          role:{type:"string",required:true,description:"Role key"},
          remove:{type:"boolean",description:"Remove the role"}},
        async run(ctx,i){const m=await ctx.server.member(i.options.user.id);if(i.options.remove)await m.removeRole(i.options.role);else await m.addRole(i.options.role);await i.reply("ok");}}),
      "fixture-open":command({description:"Request a ticket through its versioned action",async run(ctx,i){
        const result=await ctx.plugins.call("tickets","open",{userId:i.user.id,type:"help",subject:"Deferred action",description:"One request"},{idempotencyKey:"fixture-open-"+i.user.id});
        await i.reply(JSON.stringify(result));
      }}),
      "fixture-open-twice":command({description:"Send one request twice concurrently",async run(ctx,i){
        const input={userId:i.user.id,type:"help",subject:"Concurrent action",description:"Two realms"};
        const results=await Promise.all([1,2].map(()=>ctx.plugins.call("tickets","open",input,{idempotencyKey:"fixture-twice-"+i.user.id})));
        await i.reply(JSON.stringify(results));
      }}),
      "fixture-files":command({description:"Inspect a simulated transcript upload",permissions:["ManageRoles"],async run(ctx,i){
        const rows=await ctx.server.channel("private-log").messages({limit:50});
        await i.reply(JSON.stringify(rows.flatMap(m=>m.attachments.map(a=>a.filename))));
      }}),
      "fixture-dm":command({description:"Open the simulator DM channel",async run(ctx,i){const m=await i.member.send("Simulator DM channel ready");await i.reply(m.channel.id);}})
    }});`,
  );
  const valid = await readFile(bot, "utf8");
  await writeFile(bot, valid.replace('"discord.channels.manage",', ""));
  try {
    const validation = spawnSync("cicord", ["validate", repo], { encoding: "utf8" });
    assert.notEqual(validation.status, 0);
    assert.match(validation.stdout + validation.stderr, /discord.channels.manage/);
  } finally {
    await writeFile(bot, valid);
  }
  const restored = spawnSync("cicord", ["validate", repo], { encoding: "utf8" });
  assert.equal(restored.status, 0, restored.stdout + restored.stderr);
}

async function until(description, read, timeout = 3000) {
  const start = Date.now();
  let result;
  do {
    try {
      result = await read();
    } catch (error) {
      // The portal limits each user to 120 requests a minute: a poll answered 429 is "not yet".
      if (!/ returned 429:/.test(String(error?.message))) throw error;
      result = undefined;
    }
    if (result) return result;
    await delay(250);
  } while (Date.now() - start < timeout);
  assert.fail(description);
}

test(
  "typed access, revocation, offline transcripts and selected-server modmail",
  { timeout: 45000 },
  async (t) => {
    const config = {
      panelChannel: "general",
      locale: "fr",
      modmailType: "help",
      types: [
        {
          key: "help",
          name: "Help",
          staffRoles: ["moderator"],
          logChannel: "private-log",
          retainSourceForTranscript: true,
        },
        { key: "appeal", name: "Appeals", staffRoles: ["member"] },
      ],
    };
    const sim = await startSimulator(t, dir, grants, config, {prepare});
    const state = await sim.api("/api/v1/sim/state"),
      first = state.servers.find((g) => g.id !== secondID),
      second = state.servers.find((g) => g.id === secondID);
    const alice = sim.users.find((u) => u.username === "alice"),
      bob = sim.users.find((u) => u.username === "bob"),
      charlie = sim.users.find((u) => u.username === "charlie");
    for (const guild of [first, second])
      for (const user of [alice, bob, charlie])
        await sim.api("/api/v1/sim/servers/" + guild.id + "/members", { userId: user.id });
    const command = (guild, user, name, options) =>
      sim.api("/api/v1/sim/commands", {
        serverId: guild.id,
        channelId: guild.channels.find((c) => c.name === "general").id,
        userId: user.id,
        bot: "bot",
        name,
        options,
      });
    async function role(guild, user, key, remove = false) {
      const result = await command(guild, sim.owner, "fixture-role", {
        user: user.id,
        role: key,
        remove,
      });
      assert.equal(result.response?.content, "ok", JSON.stringify(result));
    }
    for (const guild of [first, second]) {
      await role(guild, bob, "moderator");
      await role(guild, charlie, "member");
    }
    const auth = new Map();
    for (const user of [alice, bob, charlie, sim.owner]) auth.set(user.id, await sim.login(user));
    const tickets = (key, user, path = "", body) =>
      sim.api(
        "/api/v1/portal/" + key + "/plugins/bot/tickets/tickets" + path,
        body,
        auth.get(user.id),
      );
    const create = (user, type, subject) =>
      tickets("acceptance", user, "", {
        subject,
        type,
        description: "Private details for " + subject,
      });
    const attempts = await Promise.allSettled([
      create(alice, "help", "Access problem"),
      create(alice, "help", "Access problem"),
    ]);
    const openedOnce = attempts.filter((r) => r.status === "fulfilled");
    assert.equal(openedOnce.length, 1, "simultaneous creates respect member quota");
    assert.match(String(attempts.find((r) => r.status === "rejected")?.reason), /409/);
    const a = openedOnce[0].value;
    const b = await create(sim.owner, "appeal", "Account appeal");
    const opened = await tickets("acceptance", bob, "/" + a.id);
    const welcome = (await sim.api("/api/v1/sim/channels/" + opened.channelId + "/messages"))
      .items[0];
    assert.match(welcome.content, /Bonjour/);
    assert.equal(welcome.components[0].components[0].label, "Fermer");
    assert.deepEqual(
      (await tickets("acceptance", bob)).items.map((x) => x.id),
      [a.id],
    );
    assert.deepEqual(
      (await tickets("acceptance", charlie)).items.map((x) => x.id),
      [b.id],
    );
    await assert.rejects(tickets("acceptance", bob, "/" + b.id), /404/);
    await assert.rejects(tickets("acceptance", charlie, "/" + a.id), /404/);
    const say = (user, channelId, content) =>
      sim.api("/api/v1/sim/messages", { userId: user.id, channelId, content });
    await assert.rejects(say(charlie, opened.channelId, "Cannot read this queue"), /403/);
    await say(bob, opened.channelId, "A scoped answer");
    for (let i = 1; i < 500; i++) await say(bob, opened.channelId, "Archive line " + i);
    await tickets("acceptance", bob, "/" + a.id + "/close", {});
    await assert.rejects(say(bob, opened.channelId, "Archived channel is read-only"), /403/);
    const upload = await command(first, sim.owner, "fixture-files", {});
    assert.deepEqual(JSON.parse(upload.response.content).sort(), [
      "ticket-" + a.id + ".html",
      "ticket-" + a.id + ".md",
    ]);
    for (const format of ["html", "markdown"]) {
      const transcript = await tickets(
        "acceptance",
        alice,
        "/" + a.id + "/transcript?format=" + format,
      );
      assert.match(transcript.content, /A scoped answer/);
      assert.match(transcript.content, /Archive line 499/);
      assert.equal(transcript.content.match(/Archive line /g)?.length, 499);
      assert.ok(Buffer.byteLength(transcript.content) < 2 * 1024 * 1024);
    }
    await assert.rejects(tickets("acceptance", charlie, "/" + a.id + "/transcript"), /404/);
    await role(first, bob, "moderator", true);
    await assert.rejects(tickets("acceptance", bob, "/" + a.id + "/transcript"), /404/);
    await assert.rejects(tickets("acceptance", bob, "/" + a.id), /403|404/);
    const accepted = await command(second, charlie, "fixture-open", {});
    const logical = JSON.parse(accepted.response.content);
    assert.ok(logical.id);
    assert.equal(logical.channelId, undefined, "the action commits before Discord provisioning");
    const committed = await until(
      "committed action provisions its channel",
      async () => {
        const detail = await tickets("secondary", bob, "/" + logical.id);
        return detail.channelId ? detail : undefined;
      },
      7000,
    );
    const retried = await command(second, charlie, "fixture-open", {});
    assert.deepEqual(JSON.parse(retried.response.content), logical);
    assert.equal(
      (await tickets("secondary", bob)).items.filter((x) => x.id === logical.id).length,
      1,
    );
    assert.ok(committed.channelId);
    // Each provider call runs in a fresh realm: the receipt, not module state, deduplicates.
    const twice = JSON.parse(
      (await command(first, alice, "fixture-open-twice", {})).response.content,
    );
    assert.equal(twice.length, 2);
    assert.deepEqual(twice[0], twice[1]);
    assert.equal(
      (await tickets("acceptance", alice, "/mine")).items.filter(
        (x) => x.subject === "Concurrent action",
      ).length,
      1,
    );
    const bootstrap = await command(first, alice, "fixture-dm", {});
    const dm = bootstrap.response.content;
    const dms = () => sim.api("/api/v1/sim/users/" + alice.id + "/dms");
    await say(alice, dm, "Modmail original");
    const prompt = await until("server selector", async () =>
      (await dms()).items.find((m) => m.components?.[0]?.components?.[0]?.type === "select"),
    );
    for (const key of ["acceptance", "secondary"]) {
      const mine = await tickets(key, alice, "/mine");
      assert.ok(mine.items.every((t) => t.source !== "modmail"));
    }
    const select = prompt.components[0].components[0];
    assert.deepEqual(new Set(select.options.map((o) => o.value)), new Set([first.id, second.id]));
    await sim.api("/api/v1/sim/components", {
      userId: alice.id,
      channelId: dm,
      messageId: prompt.id,
      customId: select.customId,
      values: [second.id],
    });
    const mail = await until("modmail on chosen server", async () =>
      (await tickets("secondary", bob)).items.find((t) => t.source === "modmail"),
    );
    assert.ok(
      (await tickets("acceptance", alice, "/mine")).items.every((t) => t.source !== "modmail"),
    );
    const messages = () => sim.api("/api/v1/sim/channels/" + mail.channelId + "/messages");
    await until("initial DM delivered", async () =>
      (await messages()).items.some(
        (m) =>
          m.content === "Modmail original" ||
          m.embeds?.some((e) => e.description === "Modmail original"),
      ),
    );
    const inbound = Date.now();
    await say(alice, dm, "Second message");
    await until(
      "inbound relay",
      async () => (await messages()).items.some((m) => m.content === "Second message"),
      2000,
    );
    assert.ok(Date.now() - inbound < 2000);
    const outbound = Date.now();
    await say(bob, mail.channelId, "Staff answer");
    await until(
      "staff relay",
      async () => (await dms()).items.some((m) => m.content === "Staff answer"),
      2000,
    );
    assert.ok(Date.now() - outbound < 2000);
    const other = await sim.api("/api/v1/sim/users", { username: "dave" });
    await sim.api("/api/v1/sim/servers/" + second.id + "/members", { userId: other.id });
    const otherDm = (await command(second, other, "fixture-dm", {})).response.content;
    await say(other, otherDm, "Unchanged conversation");
    const otherTicket = await until("second open conversation", async () =>
      (await tickets("secondary", bob)).items.find(
        (t) => t.source === "modmail" && t.author.id === other.id,
      ),
    );
    const moderators = second.roles.find((r) => r.name === "Moderator");
    await sim.api("/api/v1/sim/channels/" + mail.channelId + "/permissions", {
      overwrites: [
        { type: "role", id: second.id, deny: ["ViewChannel"] },
        {
          type: "role",
          id: moderators.id,
          allow: ["ViewChannel", "ReadMessageHistory", "SendMessages"],
        },
        { type: "member", id: alice.id, allow: ["ViewChannel"], deny: ["ReadMessageHistory"] },
      ],
    });
    await say(bob, mail.channelId, "After revoked history");
    await say(bob, otherTicket.channelId, "Unaffected thread");
    await until("unchanged recipient receives the staff answer", async () =>
      (await sim.api("/api/v1/sim/users/" + other.id + "/dms")).items.some(
        (m) => m.content === "Unaffected thread",
      ),
    );
    assert.ok(!(await dms()).items.some((m) => m.content === "After revoked history"));
    // Discord ACL drift while the member conversation is active. Wait for the
    // withheld-delivery response before asserting the selected guild got no copy.
    await sim.api("/api/v1/sim/channels/" + mail.channelId + "/permissions", {
      overwrites: [
        {
          type: "role",
          id: second.id,
          allow: ["ViewChannel", "ReadMessageHistory", "SendMessages"],
        },
      ],
    });
    await say(alice, dm, "Confidential attachment description");
    await until("member notified of withheld modmail", async () =>
      (await dms()).items.some((m) => m.content.includes("message privé n’a pas été transmis")),
    );
    assert.ok(
      !(await messages()).items.some((m) => m.content === "Confidential attachment description"),
    );
    const logChannel = first.channels.find((c) => c.name === "private-log");
    await sim.api("/api/v1/sim/channels/" + logChannel.id + "/permissions", {
      overwrites: [{ type: "role", id: first.id, allow: ["ViewChannel", "ReadMessageHistory"] }],
    });
    await until("widening the log retracts its native files", async () => {
      const result = await command(first, sim.owner, "fixture-files", {});
      return JSON.parse(result.response.content).length === 0;
    });
  },
);
