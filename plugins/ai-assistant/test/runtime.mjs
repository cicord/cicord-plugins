import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
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
      documentBaseURL: "https://docs.example.org/",
      fallbackContact: { text: "Help desk", url: "https://help.example.org/" },
    },
    {
      health: "Degraded",
      instance: {
        files: ["knowledge/**/*.md"],
        secrets: { API_KEY: { secretRef: "TEST_ASSISTANT_PROVIDER" } },
      },
      files: { "knowledge/help.md": "# Recovery\nVisit the help desk for assistance." },
    },
  );
  const token = await sim.login(sim.owner);
  const instance = await sim.api(
    "/api/v1/servers/acceptance/plugins/bot/ai-assistant",
    undefined,
    token,
  );
  assert.match(instance.message, /API_KEY/);
  assert.equal(instance.secrets[0].bound, true);
  const review = await sim.api(
    "/api/v1/portal/acceptance/plugins/bot/ai-assistant/unanswered",
    undefined,
    token,
  );
  assert.deepEqual(review.items, []);
});
