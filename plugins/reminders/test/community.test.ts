import { expect, test, vi, afterEach, beforeEach } from "vite-plus/test";
import { createTestContext, runCommand, runComponent } from "@cicord/sdk/testing";
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
import { parseDate } from "../src/time.ts";
test("tomorrow/demain, spring gap and first repeated autumn hour", () => {
  const now = Date.parse("2026-03-28T08:00:00Z");
  expect(parseDate("tomorrow 9am", "Europe/Paris", now)).toBe(
    parseDate("demain 9h", "Europe/Paris", now),
  );
  expect(parseDate("demain 9h", "Europe/Paris", now)).toBe(Date.parse("2026-03-29T07:00:00Z"));
  expect(parseDate("2026-03-29 02:30", "Europe/Paris", now)).toBe(
    Date.parse("2026-03-29T01:30:00Z"),
  );
  expect(parseDate("2026-10-25 02:15", "Europe/Paris", now)).toBe(
    Date.parse("2026-10-25T00:15:00Z"),
  );
  expect(parseDate("2026-02-30 09:00", "UTC", now)).toBeUndefined();
});
test("late delivery, owner-only cancellation, replay and single-use snooze", async () => {
  const t = setup({ locale: "fr", maxActive: 1 });
  const create = (user: string) =>
    runCommand(plugin, t, "remind create", {
      user,
      options: { when: "2h", message: "rendez-vous" },
    });
  await Promise.all([create("1"), create("1")]);
  const ids = await t.ctx.kv.get<string[]>("active:1");
  expect(ids).toHaveLength(1);
  const r = await runCommand(plugin, t, "remind cancel", { user: "2", options: { id: ids![0] } });
  expect(r.replies[0]).toBe(fr.missing);
  const pending = t.scheduled.find((x) => x.task === "deliver")!;
  vi.setSystemTime(Date.now() + 125 * 60000);
  await plugin.tasks!.deliver!(t.ctx, pending.payload);
  await plugin.tasks!.deliver!(t.ctx, pending.payload);
  expect(t.sent).toHaveLength(1);
  const msg = t.sent[0]!.message as {
    content: string;
    components: { components: { id: string }[] }[];
  };
  expect(msg.content).toContain("5 min de retard");
  const button = msg.components[0]!.components[0]!.id;
  await runComponent(plugin, t, button, { user: "2" });
  expect(await t.ctx.kv.get("active:2")).toBeUndefined();
  await runComponent(plugin, t, button, { user: "1" });
  await runComponent(plugin, t, button, { user: "1" });
  expect(await t.ctx.kv.get("active:1")).toHaveLength(1);
  await runCommand(plugin, t, "timezone set", { user: "1", options: { zone: "Europe/Paris" } });
  await create("2");
  await plugin.privacy!.erase(t.ctx, "1");
  expect(await plugin.privacy!.export(t.ctx, "1")).toEqual({
    reminders: [],
    snoozes: [],
    timeZone: null,
  });
  expect(await t.ctx.kv.get("active:2")).toHaveLength(1);
});
test("repeat obeys configured minimum and advances past missed periods", async () => {
  const t = setup({ minRepeatMinutes: 60 });
  const create = (repeat: string) =>
    runCommand(plugin, t, "remind create", {
      user: "1",
      options: { when: "1h", message: "test", repeat },
    });
  await create("10m");
  expect(t.scheduled).toHaveLength(0);
  await create("2h");
  const first = t.scheduled[0]!;
  vi.setSystemTime(Date.now() + 8 * 3600000);
  await plugin.tasks!.deliver!(t.ctx, first.payload);
  await plugin.tasks!.deliver!(t.ctx, first.payload);
  expect(t.sent).toHaveLength(1);
  expect(t.scheduled.at(-1)!.delayMs).toBe(3600000);
});
