import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { startSimulator } from "../../../scripts/simulator.mjs";
const dir = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
test(
  "calendar subscription and staff event creation through Discord and HTTP",
  { timeout: 45000 },
  async (t) => {
    const start = new Date(Date.now() + 48 * 3600000).toISOString();
    const sim = await startSimulator(
      t,
      dir,
      [
        "discord.events.read",
        "discord.events.manage",
        "discord.members.read",
        "discord.channels.read",
        "discord.messages.send",
        "discord.dm.send",
        "scheduler",
        "storage.kv",
        "portal.routes",
        "events.publish",
      ],
      {
        weeksAhead: 2,
        series: [
          { key: "weekly", name: "Town hall", start, durationMinutes: 60, location: "Club" },
        ],
      },
    );
    const route = "/api/v1/portal/acceptance/plugins/bot/community-events/calendar";
    const calendar = await sim.api(route);
    assert.equal(calendar.length, 2);
    assert.equal(new Set(calendar.map((x) => x.id)).size, 2);
    const response = await fetch(`http://127.0.0.1:${sim.port}${route}.ics`);
    assert.equal(response.headers.get("content-type"), "text/calendar; charset=utf-8");
    assert.match(await response.text(), /RRULE:FREQ=WEEKLY/);
    const alice = sim.users.find((u) => u.username === "alice");
    await sim.join(alice);
    const denied = await sim.command(alice, "event create");
    assert.match(JSON.stringify(denied), /Staff access required/);
    const modal = await sim.command(sim.owner, "event create");
    assert.equal(modal.status, "modal", JSON.stringify(modal));
    const submitted = await sim.api("/api/v1/sim/modals", {
      userId: sim.owner.id,
      serverId: sim.guild.id,
      channelId: sim.channel.id,
      bot: "bot",
      customId: modal.modal.customId,
      fields: {
        name: "Special meeting",
        location: "Lobby",
        start,
        end: new Date(Date.parse(start) + 3600000).toISOString(),
      },
    });
    assert.equal(submitted.status, "replied", JSON.stringify(submitted));
    assert.ok((await sim.api(route)).some((e) => e.name === "Special meeting"));
  },
);
