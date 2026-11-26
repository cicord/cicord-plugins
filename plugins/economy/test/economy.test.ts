import { expect, test } from "vite-plus/test";
import { createTestContext, runCommand } from "@cicord/sdk/testing";
import plugin from "../src/index.ts";
import { pay, transact } from "../src/ledger.ts";
import schema from "../config.schema.json" with { type: "json" };
import en from "../locales/en.json" with { type: "json" };

test("1,000 simultaneous payments conserve balances, including tax, with idempotent late delivery", async () => {
  const h = createTestContext({
    schema,
    config: { enabled: true, taxPercent: 10 },
    locales: { en },
  });
  await transact(h.ctx, "opening", [{ userId: "1", amount: 10000 }], "opening");
  const ids = Array.from({ length: 1000 }, (_, i) => String(i));
  await Promise.all(ids.map((id) => pay(h.ctx, id, "1", "2", 10)));
  expect(h.kv.get("balance:1")).toBe(0);
  expect(h.kv.get("balance:2")).toBe(9000);
  expect(h.kv.get("balance:treasury")).toBe(1000);
  expect(await pay(h.ctx, "42", "1", "2", 10)).toBeGreaterThanOrEqual(0);
  await expect(pay(h.ctx, "overdraw", "1", "2", 1)).rejects.toThrow("funds");
  expect(h.kv.get("balance:2")).toBe(9000);
}, 60000);
test("replayed credit, two members, erasure and disabled pilot", async () => {
  const h = createTestContext({ schema, config: { enabled: true }, locales: { en } });
  await Promise.all(
    [0, 1, 2].map(() => transact(h.ctx, "grant", [{ userId: "1", amount: 100 }], "reward")),
  );
  await pay(h.ctx, "purchase", "1", "2", 50);
  await plugin.privacy!.erase(h.ctx, "1");
  expect(await plugin.privacy!.export(h.ctx, "1")).toEqual([]);
  expect(h.kv.get("balance:2")).toBe(50);
  const off = createTestContext({ schema, locales: { en }, members: [{ id: "1" }] });
  expect((await runCommand(plugin, off, "daily", { user: "1" })).replies).toEqual([en.off]);
  expect(off.kv.size).toBe(0);
});
