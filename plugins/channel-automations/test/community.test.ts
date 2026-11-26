import { expect, test, vi, afterEach, beforeEach } from "vite-plus/test";
import { createTestContext } from "@cicord/sdk/testing";
import schema from "../config.schema.json" with { type: "json" };
import en from "../locales/en.json" with { type: "json" };
import fr from "../locales/fr.json" with { type: "json" };
import plugin from "../src/index.ts";

function setup(config: Record<string, unknown> = {}, disabled: string[] = []) {
  const t = createTestContext({
    schema,
    locales: { en, fr },
    config,
    server: { ownerId: "1" },
    roles: { staff: { name: "Staff" }, duty: { name: "Duty" }, birthday: { name: "Birthday" } },
    channels: { general: { name: "General" }, news: { name: "News", type: "announcement" } },
    members: [{ id: "1", roles: ["staff"] }, { id: "2" }],
  });
  Object.assign(t.ctx, {
    features: { enabled: (f: string) => !disabled.includes(f) },
    plugins: { has: () => false },
  });
  return t;
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse("2026-02-28T08:00:00Z"));
});
afterEach(() => vi.useRealTimers());
import type { Message } from "@cicord/sdk";
async function post(t: ReturnType<typeof setup>, text: string, id = "1") {
  const msg = await t.channel("general")!.send(text);
  return Object.assign(Object.create(msg), {
    author: t.member(id)!.user,
    member: t.member(id)!,
    content: text,
    attachments: [],
  }) as Message;
}
test("missing media intent leaves messages alone; active rule sends at most one DM per hour", async () => {
  const config = { rules: [{ channel: "general", mediaOnly: true }] };
  const missing = setup(config, ["mediaOnly"]);
  await plugin.events!.messageCreate!(missing.ctx, await post(missing, "text"));
  expect(missing.deletedMessages).toEqual([]);
  const t = setup(config);
  for (let i = 0; i < 2; i++) await plugin.events!.messageCreate!(t.ctx, await post(t, "text"));
  expect(t.deletedMessages).toHaveLength(2);
  expect(t.sent.filter((s) => s.to.startsWith("dm"))).toHaveLength(1);
  await plugin.events!.messageCreate!(t.ctx, await post(t, "https://example.org"));
  expect(t.deletedMessages).toHaveLength(2);
});
test("restart cleanup checks current pins; two writers cannot consume the same posting interval", async () => {
  const t = setup({ rules: [{ channel: "general", autoDelete: 2, onePostPer: 30 }] });
  const first = await post(t, "first"),
    second = await post(t, "second");
  await Promise.all([
    plugin.events!.messageCreate!(t.ctx, first),
    plugin.events!.messageCreate!(t.ctx, second),
  ]);
  expect(t.deletedMessages).toHaveLength(1);
  expect(t.scheduled).toHaveLength(1);
  const saved = t.deletedMessages[0]!.id === first.id ? second : first;
  await saved.pin();
  vi.setSystemTime(Date.now() + 3 * 3600000);
  const p = t.scheduled[0]!.payload;
  await plugin.tasks!.cleanup!(t.ctx, p);
  await plugin.tasks!.cleanup!(t.ctx, p);
  expect(t.deletedMessages).toHaveLength(1);
  await plugin.events!.messageCreate!(t.ctx, await post(t, "other", "2"));
  await plugin.privacy!.erase(t.ctx, "1");
  expect(await plugin.privacy!.export(t.ctx, "1")).toEqual([]);
  expect(await plugin.privacy!.export(t.ctx, "2")).not.toEqual([]);
});
test("a replayed message starts one thread and granted reactions are independent", async () => {
  const t = setup(
    { rules: [{ channel: "general", autoThread: "From {author}", autoReact: ["✅"] }] },
    ["reactions"],
  );
  const m = await post(t, "new post");
  await plugin.events!.messageCreate!(t.ctx, m);
  await plugin.events!.messageCreate!(t.ctx, m);
  expect(t.threads).toHaveLength(1);
  expect(t.threads[0]?.fromMessage).toBe(m.id);
  expect(t.reactions).toHaveLength(0);
});
