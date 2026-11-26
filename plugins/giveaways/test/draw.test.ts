import { describe, expect, test } from "vite-plus/test";
import vectors from "./vectors/gw-draw-v1.json" with { type: "json" };
import { commitment, draw, entrantsHash } from "../src/draw.ts";
import { createTestContext, runCommand, callRoute } from "@cicord/sdk/testing";
import schema from "../config.schema.json" with { type: "json" };
import en from "../locales/en.json" with { type: "json" };
import plugin from "../src/index.ts";

describe("gw-draw-v1", () => {
  for (const v of vectors)
    test("matches independent vector at draw index " + v.previous.length, () => {
      expect(commitment(v.seed)).toBe(v.expected.commitment);
      expect(entrantsHash(v.entries)).toBe(v.expected.entrantsHash);
      expect(draw(v.seed, v.id, v.entries, v.previous, v.count)).toEqual(v.expected.winners);
    });
  test("weighted distribution over 10,000 independent draw IDs", () => {
    let first = 0;
    for (let i = 0; i < 10000; i++)
      if (
        draw(
          vectors[0]!.seed,
          String(i),
          [
            { userId: "1", weight: 1 },
            { userId: "2", weight: 3 },
          ],
          [],
          1,
        )[0] === "1"
      )
        first++;
    expect((first - 2500) ** 2 / 2500 + (7500 - (10000 - first)) ** 2 / 7500).toBeLessThan(10.83);
  });
});
test("a disabled pilot and an unverifiable condition refuse startup", async () => {
  for (const [config, msg] of [
    [{}, "disabled"],
    [{ enabled: true, conditions: { level: 2 } }, "cannot be verified"],
  ] as const) {
    const h = createTestContext({
      schema,
      config: { ...config, managerRoles: ["host"] },
      roles: { host: { name: "Host" } },
      channels: { lobby: { name: "Lobby" } },
      members: [{ id: "9", roles: ["host"] }],
      locales: { en },
    });
    expect(
      (await runCommand(plugin, h, "giveaway start", { user: "9", channel: "lobby" })).replies[0],
    ).toContain(msg);
    expect(h.sent).toHaveLength(0);
  }
});
test("replayed deadline keeps the same result and changes the original announcement", async () => {
  const v = vectors[0]!,
    h = createTestContext({
      schema,
      config: { enabled: true },
      server: { everyonePermissions: ["ViewChannel", "ReadMessageHistory"] },
      locales: { en },
      channels: { lobby: { name: "Lobby" } },
      members: v.entries.map((e) => ({ id: e.userId })),
    });
  const message = await h.channel("lobby")!.send("commitment " + v.expected.commitment);
  const g = {
    id: v.id,
    prize: "Book",
    description: "",
    channelId: h.channel("lobby")!.id,
    messageId: message.id,
    closesAt: 1,
    seed: v.seed,
    commitment: v.expected.commitment,
    entrants: 4,
    slots: 2,
    state: "open",
    history: [],
    winners: [],
    claimed: [],
    round: 0,
    claimBy: 0,
    refreshAt: 0,
  };
  await h.ctx.kv.set("gw:" + g.id, g);
  for (const e of v.entries) await h.ctx.kv.set("entry:" + v.id + ":" + e.userId, e.weight);
  expect((await callRoute(plugin, h, "GET /giveaways/" + g.id)).body).not.toHaveProperty("seed");
  await plugin.tasks!.finish!(h.ctx, { id: v.id });
  await plugin.tasks!.finish!(h.ctx, { id: v.id });
  expect((await callRoute(plugin, h, "GET /giveaways/" + g.id)).body).toMatchObject({
    winners: v.expected.winners,
    seed: v.seed,
    entrantsHash: v.expected.entrantsHash,
  });
  expect(h.sent.filter((e) => e.to === "lobby")).toHaveLength(1);
  await plugin.privacy!.erase(h.ctx, "9");
  expect(await plugin.privacy!.export(h.ctx, "9")).toEqual([]);
  expect(await plugin.privacy!.export(h.ctx, "20")).toHaveLength(1);
});
test("private proof, staff rows and entrant downloads recheck the viewer’s current history permission", async () => {
  const h = createTestContext({
    schema,
    config: { enabled: true },
    locales: { en },
    server: { ownerId: "99", everyonePermissions: ["ViewChannel", "ReadMessageHistory"] },
    access: { moderators: { users: ["1", "2"] } },
    roles: { reader: { name: "Draw reader" } },
    members: [{ id: "1", roles: ["reader"] }, { id: "2" }],
    channels: {
      staff: {
        name: "staff",
        overwrites: {
          "@everyone": { deny: ["ReadMessageHistory"] },
          reader: { allow: ["ReadMessageHistory"] },
        },
      },
    },
  });
  const v = vectors[0]!,
    g = {
      id: v.id,
      prize: "private prize",
      description: "",
      source: "staff",
      channelId: h.channel("staff")!.id,
      messageId: "17",
      closesAt: 1,
      seed: v.seed,
      commitment: v.expected.commitment,
      entrants: 4,
      slots: 2,
      state: "ended",
      history: v.expected.winners,
      winners: v.expected.winners,
      claimed: [],
      round: 1,
      claimBy: 0,
      entrantsHash: v.expected.entrantsHash,
      refreshAt: 0,
    };
  await h.ctx.kv.set("gw:" + v.id, g);
  for (const e of v.entries) await h.ctx.kv.set("entry:" + v.id + ":" + e.userId, e.weight);
  const route = "GET /giveaways/" + v.id;
  const hidden = await callRoute(plugin, h, "GET /giveaways/absent");
  expect(await callRoute(plugin, h, route)).toEqual(hidden);
  expect((await callRoute(plugin, h, route, { viewer: "1" })).body).toMatchObject({
    seed: v.seed,
    entrantsHash: v.expected.entrantsHash,
  });
  expect((await callRoute(plugin, h, route, { viewer: "2" })).status).toBe(404);
  expect((await callRoute(plugin, h, "GET /giveaways", { viewer: "2" })).body).toMatchObject({
    items: [],
  });
  expect((await callRoute(plugin, h, route + "/entries", { viewer: "1" })).status).toBe(200);
  await h.member("1")!.removeRole("reader");
  for (const path of [route, route + "/entries"])
    expect((await callRoute(plugin, h, path, { viewer: "1" })).status).toBe(404);
  expect((await callRoute(plugin, h, "GET /giveaways", { viewer: "1" })).body).toMatchObject({
    items: [],
  });
});
