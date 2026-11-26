import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { startSimulator } from "../../../scripts/simulator.mjs";

test(
  "two voice users create, lock, share, transfer and leave one candidate room",
  { timeout: 30000 },
  async (t) => {
    const grants = [
      "discord.channels.read",
      "discord.channels.manage",
      "discord.voice.move",
      "discord.members.read",
      "storage.kv",
      "scheduler",
      "events.publish",
    ];
    const graceSeconds = 2;
    const sim = await startSimulator(
      t,
      fileURLToPath(new URL("..", import.meta.url)),
      grants,
      {
        hubs: [{ channel: "voice-hub", name: "Session {username}" }],
        emptyDelaySeconds: graceSeconds,
        cooldownSeconds: 0,
      },
      {
        async prepare({ repo }) {
          const file = join(repo, "servers/acceptance.yaml"),
            yaml = await readFile(file, "utf8");
          await writeFile(
            file,
            yaml.replace(
              "  channels:\n",
              "  channels:\n    voice-hub: {name: voice-hub, type: voice, category: community}\n",
            ),
          );
        },
      },
    );
    const alice = sim.users.find((u) => u.username === "alice"),
      bob = sim.users.find((u) => u.username === "bob");
    assert.ok(alice && bob);
    await sim.join(alice);
    await sim.join(bob);
    const state = async () =>
      (await sim.api("/api/v1/sim/state")).servers.find((s) => s.id === sim.guild.id);
    const waitFor = async (check, label, ms = 5000) => {
      const end = Date.now() + ms;
      do {
        const s = await state();
        if (check(s)) return s;
        await delay(25);
      } while (Date.now() < end);
      assert.fail(label);
    };
    const position = (s, user) => s.members.find((m) => m.user.id === user.id)?.voiceChannelId;
    const voice = (u, c) =>
      sim.api(
        `/api/v1/sim/servers/${sim.guild.id}/members/${u.id}/voice`,
        c ? { channelId: c.id } : undefined,
        undefined,
        c ? "PUT" : "DELETE",
      );
    const cmd = (u, name, options = {}) => sim.command(u, "voice " + name, options);
    const hub = (await state()).channels.find((c) => c.name === "voice-hub");
    assert.ok(hub);
    await voice(alice, hub);
    const created = await waitFor(
      (s) => s.channels.some((c) => c.name === "Session alice" && position(s, alice) === c.id),
      "The plugin did not create and move the owner into the room",
      2000,
    );
    const room = created.channels.find((c) => c.name === "Session alice");
    assert.equal(room.type, "voice");
    assert.equal(room.parentId, hub.parentId);
    assert.equal(position(created, bob), undefined);
    // Returning to the hub resumes the existing room. Its creation event must not produce another.
    await voice(alice, hub);
    const resumed = await waitFor(
      (s) => position(s, alice) === room.id,
      "The owner was not returned to their existing room",
    );
    assert.deepEqual(
      resumed.channels.filter((c) => c.name === "Session alice").map((c) => c.id),
      [room.id],
    );

    const locked = await cmd(alice, "lock");
    assert.equal(locked.status, "replied");
    assert.match(locked.response.content, /locked/i);
    await assert.rejects(() => voice(bob, room), /403/);
    assert.equal(position(await state(), bob), undefined);
    const permitted = await cmd(alice, "permit", { member: bob.id });
    assert.match(permitted.response.content, /can join/i);
    await voice(bob, room);
    await waitFor(
      (s) => position(s, alice) === room.id && position(s, bob) === room.id,
      "Both members must be connected",
    );
    const transfer = await cmd(alice, "transfer", { member: bob.id });
    assert.match(transfer.response.content, new RegExp(bob.id));
    const refused = await cmd(alice, "unlock");
    assert.equal(refused.status, "replied");
    assert.ok(refused.response.ephemeral);
    assert.match(refused.response.content, /belongs to/);
    const limited = await cmd(bob, "limit", { count: 2 });
    assert.match(limited.response.content, /Limit set to 2/);

    await voice(alice);
    assert.equal(position(await state(), alice), undefined);
    await delay(graceSeconds * 1000 + 300);
    const occupied = await state();
    assert.equal(position(occupied, bob), room.id);
    assert.ok(occupied.channels.some((c) => c.id === room.id));
    await voice(bob);
    const empty = await state();
    assert.equal(position(empty, bob), undefined);
    assert.ok(
      empty.channels.some((c) => c.id === room.id),
      "The empty-room grace period was skipped",
    );
    const final = await waitFor(
      (s) => !s.channels.some((c) => c.id === room.id),
      "Empty room survived its grace period",
      8000,
    );
    assert.ok(final.channels.some((c) => c.id === hub.id));
    assert.equal(position(final, alice), undefined);
    assert.equal(position(final, bob), undefined);
  },
);
