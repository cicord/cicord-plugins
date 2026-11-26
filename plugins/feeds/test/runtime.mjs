import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { startSimulator } from "../../../scripts/simulator.mjs";

test("feed URL validation uses the installation's reviewed network hosts", async (t) => {
  const dir = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
  const grants = [
    "storage.kv",
    "scheduler",
    "http.fetch",
    "discord.channels.read",
    "discord.messages.send",
  ];
  const sim = await startSimulator(
    t,
    dir,
    grants,
    {
      enabled: true,
      feeds: [{ id: "project", channel: "general", url: "https://news.example.org/releases" }],
    },
    { instance: { network: { allow: ["news.example.org"] } } },
  );
  execFileSync("cicord", ["validate", sim.repo], { stdio: "pipe" });
  const path = join(sim.repo, "bots", "bot", "bot.yaml"),
    yaml = await readFile(path, "utf8");
  await writeFile(
    path,
    yaml.replace("https://news.example.org/releases", "https://unreviewed.example.org/releases"),
  );
  assert.throws(
    () => execFileSync("cicord", ["validate", sim.repo], { stdio: "pipe" }),
    /network\.allow/,
  );
});
