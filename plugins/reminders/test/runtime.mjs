import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { startSimulator } from "../../../scripts/simulator.mjs";

test("private reminders in the simulated gateway", { timeout: 30000 }, async (t) => {
  const dir = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
  const sim = await startSimulator(
    t,
    dir,
    [
      "storage.kv",
      "scheduler",
      "discord.dm.send",
      "discord.members.read",
      "discord.channels.read",
      "discord.messages.send",
    ],
    { locale: "fr" },
  );
  const alice = sim.users.find((u) => u.username === "alice");
  await sim.join(alice);
  let r = await sim.command(alice, "remind create", { when: "2h", message: "rendez-vous" });
  assert.equal(r.status, "replied", JSON.stringify(r));
  assert.match(JSON.stringify(r), /prévu/);
  r = await sim.command(alice, "remind list");
  assert.match(JSON.stringify(r), /rendez-vous/);
  r = await sim.command(sim.owner, "remind list");
  assert.doesNotMatch(JSON.stringify(r), /rendez-vous/);
  r = await sim.command(alice, "remind cancel", { id: "1" });
  assert.match(JSON.stringify(r), /annulé/);
  // The real host's permissions of the invoking member decide a channel reminder.
  r = await sim.command(alice, "remind create", { when: "2h", message: "salon", where: "channel" });
  assert.match(JSON.stringify(r), /prévu/);
});
