import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { startSimulator } from "../../../scripts/simulator.mjs";

test(
  "portal editor previews and schedules a message in the simulator",
  { timeout: 30000 },
  async (t) => {
    const dir = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
    const sim = await startSimulator(
      t,
      dir,
      [
        "storage.kv",
        "scheduler",
        "discord.channels.read",
        "discord.messages.send",
        "portal.routes",
      ],
      {},
    );
    const route = "/api/v1/portal/acceptance/plugins/bot/announcements",
      token = await sim.login(sim.owner);
    const body = {
      channel: sim.channel.id,
      text: "An upcoming event",
      at: new Date(Date.now() + 3600000).toISOString(),
    };
    const preview = await sim.api(route + "/preview", body, token);
    assert.equal(preview.message.embeds[0].description, body.text);
    const created = await sim.api(route + "/compose", body, token);
    assert.ok(created.id);
    const scheduled = await sim.api(route + "/scheduled", undefined, token);
    assert.equal(scheduled.scheduled[0].id, created.id);
  },
);
