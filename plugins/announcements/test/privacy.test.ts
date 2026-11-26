import { createTestContext, runCommand, submitModal } from "@cicord/sdk/testing";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import schema from "../config.schema.json" with { type: "json" };
import en from "../locales/en.json" with { type: "json" };
import fr from "../locales/fr.json" with { type: "json" };
import plugin from "../src/index.ts";

function setup() {
  return createTestContext({
    locales: { en, fr },
    schema,
    grants: [
      "discord.messages.send",
      "discord.channels.read",
      "storage.kv",
      "scheduler",
      "portal.routes",
    ],
    plugin: { name: "announcements" },
    roles: {
      mod: { name: "Moderator", id: "200", permissions: ["ViewChannel", "ReadMessageHistory"] },
    },
    channels: { announcements: { name: "announcements" }, general: { name: "general" } },
    members: [
      { id: "1", username: "mia", roles: ["mod"] },
      { id: "2", username: "noa", roles: ["mod"] },
    ],
  });
}
type Harness = ReturnType<typeof setup>;
const general = {
  id: "channel-general",
  name: "general",
  type: "text",
  mention: "<#channel-general>",
};
const member = (t: Harness, id: string) => {
  const u = t.member(id)!.user;
  return { id, username: u.username, displayName: u.displayName, mention: `<@${id}>` };
};
/** Schedules an announcement by `by`, mentioning `mention`, two hours from now. */
async function schedule(t: Harness, by: string, mention: string, body: string) {
  const r = await runCommand(plugin, t, "announce", {
    user: by,
    options: { channel: general, when: "in 2h", mention: member(t, mention) },
  });
  await submitModal(plugin, t, r.modal!.id, { user: by, fields: { message: body } });
}
const rows = (t: Harness) =>
  Object.fromEntries([...t.kv].filter(([k]) => k.startsWith("ad:") || k.startsWith("draft:")));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-27T16:59:00Z"));
});
afterEach(() => vi.useRealTimers());

test("erasing one member removes their pending messages and mentions, not the other member's", async () => {
  const t = setup();
  await schedule(t, "1", "2", "by mia, mentions noa"); // ad 1
  await schedule(t, "2", "1", "by noa, mentions mia"); // ad 2
  // An open /announce form by mia (a draft until the modal is submitted).
  await runCommand(plugin, t, "announce", {
    user: "1",
    options: { channel: general, when: "in 3h", mention: member(t, "2") },
  });
  expect(Object.keys(rows(t)).sort()).toEqual(["ad:00000001", "ad:00000002", "draft:3"]);
  expect(t.scheduled.map((s) => s.payload)).toEqual([{ id: 1 }, { id: 2 }]);

  const exported = (await plugin.privacy!.export(t.ctx, "1")) as Record<string, unknown>[];
  expect(exported).toHaveLength(3);
  expect(exported).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: 1,
        body: "by mia, mentions noa",
        by: { id: "1", name: "mia" },
      }),
      { mention: "1" },
      expect.objectContaining({ owner: "1", channelId: "channel-general" }),
    ]),
  );
  expect(JSON.stringify(exported)).not.toContain("by noa");

  const before = rows(t);
  expect((await t.eraseMember(plugin, "1")).erased).toBe(3);
  const after = rows(t);
  // mia's announcement, its timer and her open form are gone.
  expect(Object.keys(after)).toEqual(["ad:00000002"]);
  expect(t.scheduled.map((s) => s.payload)).toEqual([{ id: 2 }]);
  // noa's announcement survives; only mia's mention is removed from it.
  const { mentions, ...rest } = before["ad:00000002"] as { mentions: Record<string, unknown> };
  expect(after["ad:00000002"]).toEqual({ ...rest, mentions: { ...mentions, user: undefined } });
  expect((after["ad:00000002"] as { mentions: object }).mentions).not.toHaveProperty("user");
  expect(await plugin.privacy!.export(t.ctx, "1")).toEqual([]);
  expect(await plugin.privacy!.export(t.ctx, "2")).toEqual([
    expect.objectContaining({ id: 2, body: "by noa, mentions mia", by: { id: "2", name: "noa" } }),
  ]);

  // The surviving announcement still posts, without the erased member's mention.
  await plugin.tasks!.post!(t.ctx, { id: 2 });
  expect(t.sent).toHaveLength(1);
  expect(JSON.stringify(t.sent[0]!.message)).not.toContain("<@1>");
});
