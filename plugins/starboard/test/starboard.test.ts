import { expect, test } from "vite-plus/test";
import { createTestContext, runCommand } from "@cicord/sdk/testing";
import plugin, { sync } from "../src/index.ts";
import schema from "../config.schema.json" with { type: "json" };
import en from "../locales/en.json" with { type: "json" };

test("recounts stars after restart, excludes self-stars and removes an inaccessible copy", async () => {
  const h = createTestContext({
    schema,
    config: { channel: "stars", threshold: 2 },
    locales: { en },
    members: [{ id: "10" }, { id: "11" }, { id: "12" }],
    server: { ownerId: "10", everyonePermissions: ["ViewChannel", "ReadMessageHistory"] },
    channels: { stars: { name: "stars" } },
  });
  const source = await h.ctx.server.createChannel({ name: "original", type: "text" });
  const m = h.receive(source.id, h.member("10")!.user, "private after the vote");
  async function star(uid: string) {
    h.setReaction(m.id, "⭐", uid);
    await plugin.events!.reactionAdd!(h.ctx, {
      message: m,
      user: h.member(uid)!.user,
      emoji: "⭐",
    });
  }
  await star("10");
  await star("11");
  await sync(h.ctx, m.id);
  expect(h.sent.filter((e) => e.to === "stars")).toHaveLength(0);
  await star("12");
  await sync(h.ctx, m.id);
  await sync(h.ctx, m.id);
  const copies = h.sent.filter((e) => e.to === "stars");
  expect(copies).toHaveLength(1);
  expect(h.message(copies[0]!.id)?.embeds[0]?.fields?.[0]?.value).toBe("2");
  await h.ctx.server.editChannel(source, {
    overwrites: { "@everyone": { deny: ["ViewChannel"] } },
  });
  expect(h.member("10")!.canView(source)).toBe(true);
  expect(h.member("11")!.canView(source)).toBe(false);
  expect((await runCommand(plugin, h, "starboard top", { user: "11" })).replies).toEqual([
    en.empty,
  ]);
  await sync(h.ctx, m.id);
  expect(await h.channel("stars")!.message(copies[0]!.id)).toBeUndefined();
  expect(await plugin.privacy!.export(h.ctx, "10")).toEqual([]);
});
