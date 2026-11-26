import { expect, test, vi, afterEach, beforeEach } from "vite-plus/test";
import { createTestContext, runCommand, callRoute } from "@cicord/sdk/testing";
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
test("overdue milestones are posted once inside the one-hour grace period; old milestones skipped", async () => {
  const t = setup({ timeZone: "UTC" });
  await runCommand(plugin, t, "countdown create", {
    user: "1",
    options: { channel: t.channel("general"), date: "2026-03-08 08:00", title: "Launch" },
  });
  const start = t.scheduled[0]!,
    run = (p: typeof start.payload) => plugin.tasks!.countdown!(t.ctx, p);
  await run(start.payload);
  const first = t.scheduled.at(-1)!;
  vi.setSystemTime(Date.parse("2026-03-07T08:25:00Z"));
  await run(first.payload);
  await run(first.payload);
  expect(t.sent.map((s) => s.message)).toContainEqual(
    expect.objectContaining({ content: "One day until **Launch**. (late)" }),
  );
  expect(t.sent).toHaveLength(2);
  const last = t.scheduled.at(-1)!;
  vi.setSystemTime(Date.parse("2026-03-08T08:02:00Z"));
  await run(last.payload);
  await run(last.payload);
  expect(t.sent).toHaveLength(3);
});
test("ten posts in five seconds queue one sticky; editor checks current channel access", async () => {
  const t = setup({ stickies: [{ channel: "general", message: "Rules", afterMessages: 3 }] });
  for (let i = 0; i < 10; i++) {
    const m = await t.channel("general")!.send("hello");
    await plugin.events!.messageCreate!(
      t.ctx,
      Object.assign(Object.create(m), { author: t.member("2")!.user }),
    );
    vi.setSystemTime(Date.now() + 500);
  }
  expect(t.scheduled).toHaveLength(1);
  vi.setSystemTime(Date.now() + 30000);
  await plugin.tasks!.sticky!(t.ctx, t.scheduled[0]!.payload);
  await plugin.tasks!.sticky!(t.ctx, t.scheduled[0]!.payload);
  expect(await t.channel("general")!.pins()).toHaveLength(1);
  const body = { channel: t.channel("general")!.id, title: "Title", text: "Body", layout: true };
  expect((await callRoute(plugin, t, "POST /preview", { viewer: "2", body })).status).toBe(403);
  expect((await callRoute(plugin, t, "POST /preview", { viewer: "1", body })).body).toMatchObject({
    message: { layout: [{ type: "text", content: "## Title\nBody" }] },
  });
});
test("a delayed retry finds the original acknowledged post through its persisted receipt", async () => {
  const t = setup({});
  const { id } = t.channel("general")!;
  const row = {
    id: 1,
    channelId: id,
    at: Date.now(),
    body: "Posted",
    mentions: { roles: [] },
    by: { id: "1", name: "Owner" },
    createdAt: new Date().toISOString(),
    sendingSince: Date.now(),
  };
  await t.ctx.kv.set("ad:00000001", row);
  await t
    .channel("general")!
    .send({
      embeds: [
        {
          description: "Posted",
          footer: { text: t.ctx.i18n.t("receipt", { id: 1, instance: t.ctx.plugin.instance }) },
        },
      ],
    });
  vi.setSystemTime(Date.now() + 6 * 3600000);
  await plugin.tasks!.post!(t.ctx, { id: 1 });
  expect(t.sent).toHaveLength(1);
  expect(await t.ctx.kv.get("ad:00000001")).toBeUndefined();
});
test("crosspost refusal keeps the announcement and never automatically repeats a failed crosspost", async () => {
  const t = setup({ crosspost: true });
  const c = t.channel("news")!;
  const published = await c.send("existing");
  const refused = vi.fn().mockRejectedValue(new Error("rate limited"));
  const original = c.send.bind(c);
  c.send = async (message) =>
    Object.assign(Object.create(await original(message)), { crosspost: refused });
  const { send } = await import("../src/community.ts");
  const result = await send(t.ctx, c, { content: "News" });
  expect(result.id).not.toBe(published.id);
  expect(refused).toHaveBeenCalledTimes(1);
  expect(t.logs.some((x) => x.message.includes("Crosspost refused"))).toBe(true);
});
