import { expect, test } from "vite-plus/test";
import { createTestContext, runCommand, callRoute } from "@cicord/sdk/testing";
import plugin from "../src/index.ts";
import { pay, transact } from "../src/ledger.ts";
import schema from "../config.schema.json" with { type: "json" };
import en from "../locales/en.json" with { type: "json" };

test("1,000 simultaneous payments conserve balances, including tax, with idempotent late delivery", async () => {
  const h = createTestContext({
    schema,
    config: { enabled: true, taxPercent: 10 },
    members: [{ id: "1" }, { id: "2" }],
    locales: { en },
  });
  await transact(h.ctx, "opening", [{ userId: "1", amount: 10000 }], "opening");
  const ids = Array.from({ length: 1000 }, (_, i) => String(i));
  const declared = plugin.commands!.pay!;
  if (!declared.run) throw new Error("Expected /pay command");
  const run = declared.run;
  await Promise.all(
    ids.map((id) =>
      runCommand(
        { commands: { pay: { ...declared, run: (ctx, i) => run(ctx, { ...i, id }) } } },
        h,
        "pay",
        { user: "1", options: { member: h.member("2")!.user, amount: 10 } },
      ),
    ),
  );
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
test("credit and debit have independent idempotency namespaces for the same caller key", async () => {
  const h = createTestContext({ schema, config: { enabled: true }, locales: { en } });
  const call = {
    idempotencyKey: "shared-key".repeat(20),
    caller: {
      plugin: "rewards",
      source: "cicord",
      bot: "community",
      instance: "rewards",
      verified: true,
    },
  };
  const credit = () => plugin.actions!.credit!.run(h.ctx, { userId: "1", amount: 100 }, call);
  expect(await credit()).toEqual({ balance: 100 });
  expect(await credit()).toEqual({ balance: 100 });
  expect(await plugin.actions!.debit!.run(h.ctx, { userId: "1", amount: 10 }, call)).toEqual({
    balance: 90,
  });
  expect(h.published.every((p) => String((p.payload as { id: string }).id).length < 128)).toBe(
    true,
  );
});
test("portal checkout charges a stable purchase once, retains the chosen item and fulfills the role", async () => {
  const h = createTestContext({
    schema,
    config: {
      enabled: true,
      shop: [
        { id: "one", label: "Role one", price: 5, type: "role", role: "winner" },
        { id: "two", label: "Role two", price: 5, type: "role", role: "winner" },
      ],
    },
    features: ["permanentRole"],
    members: [{ id: "1" }],
    roles: { winner: { name: "winner" } },
    locales: { en },
  });
  await transact(h.ctx, "initial", [{ userId: "1", amount: 10 }], "seed");
  const body = { purchaseId: "cdfad0ee-53c9-45eb-a106-d522cc34ccf6" },
    buy = (item: string) =>
      callRoute(plugin, h, "POST /shop/" + item + "/buy", { viewer: "1", body });
  expect((await callRoute(plugin, h, "POST /shop/one/buy", { body })).status).toBe(401);
  const paid = await Promise.all([buy("one"), buy("one")]);
  expect(paid.every((p) => p.status === 200)).toBe(true);
  expect((await buy("two")).status).toBe(409);
  expect(h.kv.get("balance:1")).toBe(5);
  for (const task of h.scheduled) await plugin.tasks![task.task]!(h.ctx, task.payload);
  expect(h.member("1")!.hasRole("winner")).toBe(true);
  expect((await buy("one")).body).toMatchObject({ itemId: "one", state: "delivered" });
});
