import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { startSimulator } from "../../../scripts/simulator.mjs";

test("missing provider credentials degrade only the assistant instance", async (t) => {
  const dir = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
  const grants = [
    "storage.kv",
    "storage.index",
    "scheduler",
    "discord.channels.read",
    "discord.members.read",
    "discord.messages.send",
    "files.read",
    "portal.routes",
    "http.fetch",
  ];
  const sim = await startSimulator(
    t,
    dir,
    grants,
    {
      enabled: true,
      keepUnanswered: true,
      memberInterval: 1,
      channelInterval: 1,
      documentBaseURL: "https://docs.example.org/",
      fallbackContact: { text: "Help desk", url: "https://help.example.org/" },
    },
    {
      health: "Degraded",
      instance: {
        files: ["knowledge/**/*.md"],
        secrets: { API_KEY: { secretRef: "CICORD_TEST_ASSISTANT_PROVIDER" } },
      },
      files: { "knowledge/help.md": "# Recovery\nVisit the help desk for assistance." },
    },
  );
  const token = await sim.login(sim.owner);
  const admin = "local-simulator-only";
  const instance = await sim.api(
    "/api/v1/servers/acceptance/plugins/bot/ai-assistant",
    undefined,
    admin,
  );
  assert.match(instance.message, /API_KEY/);
  assert.equal(instance.secrets[0].bound, true);
  const review = await sim.api(
    "/api/v1/portal/acceptance/plugins/bot/ai-assistant/unanswered",
    undefined,
    token,
  );
  assert.deepEqual(review.items, []);
  const alice = sim.users.find((user) => user.username === "alice");
  await sim.join(alice);
  const queue = () =>
    sim.api("/api/v1/portal/acceptance/plugins/bot/ai-assistant/unanswered", undefined, token);
  async function ask(user, question) {
    const accepted = await sim.command(user, "ask question", { question });
    assert.equal(accepted.status, "replied", JSON.stringify(accepted));
    assert.equal(accepted.response.ephemeral, true);
    assert.match(accepted.response.content, /temporarily unavailable|couldn’t find an answer/);
    assert.ok(JSON.stringify(accepted.response.components).includes("https://help.example.org/"));
    for (let n = 0; n < 80; n++) {
      if ((await queue()).items.some((item) => item.question === question)) return;
      await delay(100);
    }
    assert.fail("scheduled provider fallback did not reach staff review: " + sim.logs());
  }
  await ask(sim.owner, "owner recovery question");
  await delay(1100);
  await ask(alice, "member recovery question");
  const privacy = "/api/v1/servers/acceptance/privacy/";
  const exported = await sim.api(privacy + "export", { userId: alice.id }, admin);
  assert.equal(exported.complete, true);
  assert.ok(!JSON.stringify(exported.plugins).includes("owner recovery question"));
  await sim.api(privacy + "erase", { userId: alice.id }, admin);
  assert.deepEqual(
    (await queue()).items.map((item) => item.question),
    ["owner recovery question"],
  );
});
