import assert from "node:assert/strict";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { startSimulator } from "../../../scripts/simulator.mjs";

test("paused raid remains visible, survives a new revision and completes after resume", async (t) => {
  const dir = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
  const sim = await startSimulator(
    t,
    dir,
    [
      "discord.channels.read",
      "discord.members.read",
      "discord.messages.read",
      "discord.messages.send",
      "storage.kv",
      "scheduler",
      "events.publish",
      "events.subscribe",
      "portal.routes",
      "server.overlays",
      "server.incident",
    ],
    {
      mode: "enforce",
      staffChannel: "general",
      raid: { calmMinutes: 1, measures: { slowmode: { channels: ["general"], seconds: 7 } } },
    },
  );
  const token = "local-simulator-only",
    base = "/api/v1/servers/acceptance",
    staff = await sim.login(sim.owner);
  const raids = () =>
    sim.api("/api/v1/portal/acceptance/plugins/bot/guard/raids", undefined, staff);
  const plan = () => sim.api(base + "/plan", undefined, token);
  const audit = async () =>
    (await sim.api(base + "/audit", undefined, token)).items.filter(
      (x) => x.action === "server.incident",
    );
  const status = () => sim.api("/api/v1/status", undefined, token);
  await sim.api(base + "/pause", { reason: "test deferred incident" }, token);
  const result = await sim.command(sim.owner, "lockdown on");
  assert.equal(result.status, "replied");
  assert.match(result.response.content, /pending/i);
  const pending = (await raids()).active;
  assert.equal(pending.phase, "pending");
  assert.deepEqual(pending.pending, ["invites"]);
  assert.ok((await plan()).overlays.some((o) => o.id === "raid"));
  assert.equal((await audit()).length, 0);
  // Replacing the plugin VM discards all in-memory state while preserving KV and wakeups.
  const rev = (await status()).revision.id;
  await appendFile(join(sim.repo, "plugins/guard/src/index.ts"), "\n// fixture revision\n");
  for (let i = 0; i < 100 && (await status()).revision.id === rev; i++) await delay(100);
  assert.notEqual((await status()).revision.id, rev);
  assert.equal((await raids()).active.started, pending.started);
  await sim.api(base + "/resume", {}, token);
  for (let i = 0; i < 120 && (await raids()).active?.phase !== "active"; i++) await delay(100);
  const resumed = (await raids()).active;
  assert.equal(resumed.phase, "active");
  assert.deepEqual(resumed.pending, []);
  assert.equal((await audit()).length, 1);
  assert.equal((await plan()).changes.length, 0);
  assert.equal((await sim.command(sim.owner, "lockdown off")).status, "replied");
  const final = await raids();
  assert.equal(final.active, null);
  assert.ok(final.history.some((r) => r.started === pending.started));
  assert.equal((await plan()).overlays?.length ?? 0, 0);
});
