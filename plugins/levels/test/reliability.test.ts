import { expect, test } from "vite-plus/test";
import { createTestContext } from "@cicord/sdk/testing";
import type { EventMeta } from "@cicord/sdk";
import plugin from "../src/index.ts";
import { credit, migrate } from "../src/storage.ts";
import { position } from "../src/levels.ts";
import schema from "../config.schema.json" with { type: "json" };
import en from "../locales/en.json" with { type: "json" };

const event: EventMeta = {
  id: "event-4000",
  topic: "polls.closed",
  version: 2,
  at: "2026-11-25T09:00:00Z",
  publisher: { bot: "community", instance: "polls", plugin: "polls" },
};
test("4,000 truncated voters are fetched page by page and forced replay cannot double-credit", async () => {
  const h = createTestContext({ schema, features: ["pollBonus", "pollPages"], locales: { en } });
  Object.assign(h.ctx, {
    plugins: {
      query: async (_p: string, _m: string, i: { cursor?: string }) => {
        const offset = Number(i.cursor ?? 0);
        return {
          userIds: Array.from({ length: 1000 }, (_, n) => String(offset + n + 1)),
          ...(offset < 3000 ? { cursor: String(offset + 1000) } : {}),
        };
      },
    },
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    await plugin.subscriptions!["polls.closed"]!(
      h.ctx,
      { pollId: "9", votersTruncated: true, voterCount: 4000 },
      event,
    );
    for (let task = h.scheduled.shift(); task; task = h.scheduled.shift())
      await plugin.tasks![task.task]!(h.ctx, task.payload);
  }
  expect(await h.ctx.kv.ranking("xp").count()).toBe(4000);
  for (let i = 1; i <= 4000; i++) expect(h.kv.get("xp:" + i)).toBe(10);
});
test("restarting migration and interleaved live awards preserve exact standings and ties", async () => {
  const h = createTestContext({ schema, locales: { en } });
  for (let i = 1; i <= 2001; i++) await h.ctx.kv.set("xp:" + i, 17);
  await migrate(h.ctx);
  expect(h.kv.get("meta:cursor")).toBeTruthy();
  expect(h.kv.get("meta:schema")).toBeUndefined();
  await Promise.all([
    credit(h.ctx, "1", 10, "live"),
    credit(h.ctx, "999", 20, "live"),
    migrate(h.ctx),
  ]);
  await migrate(h.ctx);
  expect(h.kv.get("meta:schema")).toBe(2);
  expect(await position(h.ctx, "999")).toEqual({ rank: 1, xp: 37, count: 2001 });
  expect(await position(h.ctx, "1")).toEqual({ rank: 2, xp: 27, count: 2001 });
  await plugin.privacy!.erase(h.ctx, "1");
  expect(await plugin.privacy!.export(h.ctx, "1")).toEqual([]);
  expect(await position(h.ctx, "999")).toEqual({ rank: 1, xp: 37, count: 2000 });
});
test("a lone voice member earns nothing", async () => {
  const h = createTestContext({
    schema,
    config: { voice: { xpPerMinute: 5 } },
    features: ["voiceXp"],
    locales: { en },
    members: [{ id: "1" }],
    channels: { talk: { type: "voice", name: "Talk" } },
  });
  await plugin.events!.voiceStateUpdate!(h.ctx, h.setVoice("1", "talk"));
  const job = h.scheduled.shift()!;
  await plugin.tasks![job.task]!(h.ctx, job.payload);
  expect(h.kv.get("xp:1")).toBeUndefined();
});
test("simultaneous distinct reactions from one member earn one award and remove it only once", async () => {
  const h = createTestContext({
    schema,
    locales: { en },
    members: [{ id: "1" }, { id: "2" }],
    channels: { chat: { name: "Chat" } },
  });
  const message = h.receive("chat", h.member("1")!.user, "hello"),
    user = h.member("2")!.user;
  await plugin.events!.messageCreate!(h.ctx, { ...message, member: h.member("1")! });
  const initial = Number(h.kv.get("xp:1"));
  await Promise.all(
    ["😀", "⭐"].map((emoji) => plugin.events!.reactionAdd!(h.ctx, { message, user, emoji })),
  );
  expect(h.kv.get("xp:1")).toBe(initial + 2);
  await Promise.all(
    ["😀", "⭐"].map((emoji) => plugin.events!.reactionRemove!(h.ctx, { message, user, emoji })),
  );
  expect(h.kv.get("xp:1")).toBe(initial);
});
test("erasure redacts a posted announcement and preserves another member's scores", async () => {
  const h = createTestContext({
    schema,
    locales: { en },
    features: ["privacyCopies"],
    config: { xpPerMessage: 100, announce: { channel: "chat" } },
    members: [{ id: "1" }, { id: "2" }],
    channels: { chat: { name: "Chat" } },
  });
  for (const uid of ["1", "2"])
    await plugin.events!.messageCreate!(h.ctx, {
      ...h.receive("chat", h.member(uid)!.user, "hello"),
      member: h.member(uid)!,
    });
  expect(h.sent).toHaveLength(2);
  await plugin.privacy!.erase(h.ctx, "1");
  expect(h.message(h.sent[0]!.id)!.content).toBe(en.erased);
  expect(h.message(h.sent[1]!.id)!.content).toContain("<@2>");
  expect(await plugin.privacy!.export(h.ctx, "1")).toEqual([]);
});
