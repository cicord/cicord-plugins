import { expect, test } from "vite-plus/test";
import { callRoute, createTestContext, runComponent, submitModal } from "@cicord/sdk/testing";
import plugin from "../src/index.ts";
import schema from "../config.schema.json" with { type: "json" };
import en from "../locales/en.json" with { type: "json" };

test("votes can change, owners stay anonymous and only staff can decide", async () => {
  const h = createTestContext({
    schema,
    config: { channel: "ideas", anonymous: true, retainText: true },
    locales: { en },
    server: { ownerId: "1", everyonePermissions: ["ViewChannel", "ReadMessageHistory"] },
    members: [{ id: "1" }, { id: "2" }, { id: "3" }],
    channels: { ideas: { name: "ideas" } },
  });
  await submitModal(plugin, h, "suggest", {
    user: "2",
    channel: "ideas",
    fields: { body: "Install a bike rack" },
  });
  const card = h.sent[0]!,
    row = (await h.ctx.kv.list({ prefix: "suggestion:" })).items[0]!.value as { id: string };
  for (const mode of ["up", "up", "down"])
    await runComponent(plugin, h, mode + ":" + row.id, {
      user: "3",
      channel: "ideas",
      message: card.id,
    });
  const board = () => callRoute(plugin, h, "GET /suggestions");
  expect((await board()).body).toEqual({
    items: [{ id: row.id, status: "open", score: -1, body: "Install a bike rack" }],
  });
  const uri = "POST /suggestions/" + row.id + "/status",
    body = { status: "approved", reason: "Facilities approved" };
  expect((await callRoute(plugin, h, uri, { viewer: "3", body })).status).toBe(403);
  expect((await callRoute(plugin, h, uri, { viewer: "1", body })).status).toBe(200);
  for (const task of h.scheduled) await plugin.tasks![task.task]!(h.ctx, task.payload);
  expect(h.message(card.id)?.embeds[0]?.fields?.some((f) => f.name === "approved")).toBe(true);
  expect(h.published.at(-1)?.payload).toMatchObject({
    authorId: "2",
    status: "approved",
    score: -1,
  });
  await plugin.privacy!.erase(h.ctx, "3");
  expect((await board()).body).toMatchObject({ items: [{ score: 0 }] });
  expect(await plugin.privacy!.export(h.ctx, "3")).toEqual([]);
  await plugin.privacy!.erase(h.ctx, "2");
  expect((await board()).body).toEqual({ items: [] });
});
test("private suggestions stay out of anonymous and unauthorized portal views", async () => {
  const h = createTestContext({
    schema,
    config: { channel: "staff", retainText: true },
    locales: { en },
    server: { ownerId: "1", everyonePermissions: ["ViewChannel", "ReadMessageHistory"] },
    members: [{ id: "1" }, { id: "2" }],
    channels: { staff: { name: "staff", overwrites: { "@everyone": { deny: ["ViewChannel"] } } } },
  });
  await submitModal(plugin, h, "suggest", {
    user: "1",
    channel: "staff",
    fields: { body: "Private proposal" },
  });
  expect((await callRoute(plugin, h, "GET /suggestions")).body).toEqual({ items: [] });
  expect((await callRoute(plugin, h, "GET /suggestions", { viewer: "2" })).body).toEqual({
    items: [],
  });
  expect((await callRoute(plugin, h, "GET /suggestions", { viewer: "1" })).body).toMatchObject({
    items: [{ body: "Private proposal" }],
  });
});
