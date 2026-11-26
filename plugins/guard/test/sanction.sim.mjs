import assert from "node:assert/strict";
import { cp, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { startSimulator } from "../../../scripts/simulator.mjs";

test("native guard sends permanent bans and timed timeouts through moderation", async (t) => {
  const guard = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
  const moderation = fileURLToPath(new URL("../../moderation", import.meta.url));
  const sim = await startSimulator(
    t,
    guard,
    [
      "discord.channels.read",
      "discord.members.read",
      "discord.messages.send",
      "discord.messages.read",
      "storage.kv",
      "scheduler",
      "portal.routes",
      "events.publish",
      "events.subscribe",
      "plugins.call:moderation.sanction",
      "server.overlays",
      "server.incident",
    ],
    {
      mode: "enforce",
      staffChannel: "general",
      raid: {
        joins: 3,
        seconds: 120,
        youngPercent: 0,
        calmMinutes: 1,
        measures: { slowmode: { channels: ["general"], seconds: 5 } },
      },
      links: { domains: ["test.invalid"], action: { type: "ban" } },
      mentions: { perMessage: 1, action: { type: "timeout", minutes: 7 } },
      newAccounts: { restrict: [] },
    },
    {
      prepare: async ({ repo }) => {
        await cp(moderation, join(repo, "plugins/moderation"), {
          recursive: true,
          filter: (file) => !file.endsWith("/.cicord"),
        });
        const bot = join(repo, "bots/bot/bot.yaml");
        await writeFile(
          bot,
          (await readFile(bot, "utf8")) +
            `
    - name: moderation
      source: ../../plugins/moderation
      grants: [discord.auditlog.read, discord.channels.read, discord.messages.send, discord.messages.manage, discord.members.read, discord.messages.read, discord.members.moderate, discord.dm.send, storage.kv, scheduler, http.fetch, portal.routes, events.publish]
      config: {logChannel: general, flood: {enabled: false}, log: {joins: false, leaves: false, updates: false}}
`,
        );
      },
    },
  );
  const staff = await sim.login(sim.owner);
  async function check(username, content, action) {
    const user = sim.users.find((u) => u.username === username);
    assert.ok(user, `missing simulator user ${username}`);
    await sim.join(user);
    await sim.api("/api/v1/sim/messages", { userId: user.id, channelId: sim.channel.id, content });
    for (let i = 0; i < 50; i++) {
      const page = await sim.api(
        "/api/v1/portal/acceptance/plugins/bot/moderation/cases",
        undefined,
        staff,
      );
      const row = page.items.find((c) => c.member?.id === user.id && c.source?.plugin === "guard");
      if (row) {
        assert.equal(row.action, action);
        return { user, row };
      }
      await delay(100);
    }
    const guardRows = await sim.api(
      "/api/v1/portal/acceptance/plugins/bot/guard/violations",
      undefined,
      staff,
    );
    assert.fail(`no moderation case for ${action}: ${JSON.stringify(guardRows)}`);
  }
  const permanent = await check("alice", "https://test.invalid/notice", "ban");
  assert.equal(permanent.row.expiresAt, undefined);
  await assert.rejects(() => sim.join(permanent.user), /403/);
  const timed = await check("bob", "<@" + sim.owner.id + ">", "timeout");
  assert.equal(timed.row.durationMinutes, 7);
  assert.ok(Date.parse(timed.row.expiresAt) > Date.now() + 6 * 60000);

  // A real raid button previously supplied a zero duration to the moderation
  // schema. Drive the staff-only review, selection, and independent confirmation.
  const third = sim.users.find((u) => u.username === "charlie");
  await sim.join(third);
  let card;
  for (let i = 0; i < 50 && !card; i++) {
    const page = await sim.api("/api/v1/sim/channels/" + sim.channel.id + "/messages");
    card = page.items.find((m) =>
      m.components?.[0]?.components?.some((b) => b.label === "Review arrivals"),
    );
    if (!card) await delay(100);
  }
  assert.ok(card, "missing raid staff review");
  const plan = await sim.api("/api/v1/servers/acceptance/plan", undefined, "local-simulator-only");
  assert.ok(plan.overlays?.some((o) => o.id === "raid" && o.origin === "bot/guard"));
  assert.equal(plan.changes.length, 0);
  const audit = await sim.api(
    "/api/v1/servers/acceptance/audit",
    undefined,
    "local-simulator-only",
  );
  assert.ok(
    audit.items.some(
      (row) =>
        row.action === "server.incident" &&
        row.actor === "plugin:bot/guard" &&
        Date.parse(row.details.invitesDisabledUntil) > Date.now(),
    ),
  );
  function interact(message, component, values) {
    return sim.api("/api/v1/sim/components", {
      userId: sim.owner.id,
      channelId: sim.channel.id,
      messageId: message.id,
      customId: component.customId,
      ...(values ? { values } : {}),
    });
  }
  const choices = await interact(
    card,
    card.components[0].components.find((b) => b.label === "Review arrivals"),
  );
  assert.equal(choices.status, "replied", JSON.stringify(choices));
  const confirmation = await interact(
    choices.response,
    choices.response.components[0].components[0],
    [third.id],
  );
  assert.equal(confirmation.status, "replied", JSON.stringify(confirmation));
  assert.ok(confirmation.response.content.includes(third.id));
  const completed = await interact(
    confirmation.response,
    confirmation.response.components[0].components[0],
  );
  assert.equal(completed.status, "replied", JSON.stringify(completed));
  const cases = await sim.api(
    "/api/v1/portal/acceptance/plugins/bot/moderation/cases",
    undefined,
    staff,
  );
  const raidBan = cases.items.find((c) => c.member?.id === third.id);
  assert.equal(raidBan?.action, "ban", JSON.stringify(cases));
  assert.equal(raidBan.expiresAt, undefined);
  await assert.rejects(() => sim.join(third), /403/);
});
