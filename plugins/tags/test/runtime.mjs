import assert from "node:assert/strict";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { startSimulator } from "../../../scripts/simulator.mjs";

test("Git removals refresh tag search, and moderators manage portal answers", async (t) => {
  const dir = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
  const grants = [
    "storage.kv",
    "discord.messages.send",
    "discord.channels.read",
    "discord.members.read",
    "portal.routes",
    "files.read",
  ];
  const sim = await startSimulator(
    t,
    dir,
    grants,
    { enabled: true, editableOnPortal: true },
    {
      instance: { files: ["tags/**/*.md"] },
      files: {
        "tags/reset.md": "---\nname: Reset\naliases: [restart]\n---\nRestart the application.",
      },
    },
  );
  const token = await sim.login(sim.owner),
    path = "/api/v1/portal/acceptance/plugins/bot/tags/tags";
  const search = () => sim.api(path + "?q=restart", undefined, token);
  assert.equal((await search()).entries[0]?.name, "Reset");
  await unlink(join(sim.repo, "tags/reset.md"));
  for (let n = 0; n < 80 && (await search()).entries.length; n++) await delay(100);
  assert.equal((await search()).entries.length, 0);
  const tag = { name: "Desk", text: "Contact the help desk.", aliases: [], keywords: [] };
  assert.equal((await sim.api(path + "/Desk", tag, token, "PUT")).saved, true);
  assert.equal((await sim.api(path + "?q=desk", undefined, token)).entries[0]?.text, tag.text);
  assert.equal((await sim.api(path + "/Desk", undefined, token, "DELETE")).deleted, true);
});
