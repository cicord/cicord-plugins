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
test("batch migration resumes from the stored cursor, expires stale rows and isolates erasure", async () => {
  const t = setup({ steps: [] });
  for (let i = 0; i < 83; i++)
    await t.ctx.kv.set("completed:" + String(i).padStart(3, "0"), {
      at: new Date().toISOString(),
      answers: { roles: ["staff"] },
    });
  await t.ctx.kv.set("completed:old", { at: "2020-01-01", answers: {} });
  await plugin.onStart!(t.ctx);
  await plugin.tasks!.migrate!(t.ctx, {});
  expect(await t.ctx.kv.get("meta:cursor")).toBeTruthy();
  await plugin.onStart!(t.ctx);
  await plugin.tasks!.migrate!(t.ctx, {});
  await plugin.tasks!.migrate!(t.ctx, {});
  expect(await t.ctx.kv.get("meta:schema")).toBe(2);
  expect(await t.ctx.kv.get("completed:old")).toBeUndefined();
  expect(await plugin.privacy!.erase(t.ctx, "001")).toEqual({ erased: 1 });
  expect(await plugin.privacy!.export(t.ctx, "001")).toEqual({});
  expect(await plugin.privacy!.export(t.ctx, "002")).toMatchObject({
    answers: { roles: ["staff"] },
  });
});
