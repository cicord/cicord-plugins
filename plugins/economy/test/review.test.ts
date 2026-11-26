import { afterEach, expect, test, vi } from "vite-plus/test";
import { InteropError, type Context, type Json } from "@cicord/sdk";
import { createTestContext, runCommand, callRoute, type TestHarness } from "@cicord/sdk/testing";
import plugin from "../src/index.ts";
import { transact } from "../src/ledger.ts";
import { DELIVERY_HOURS } from "../src/shop.ts";
import schema from "../config.schema.json" with { type: "json" };
import en from "../locales/en.json" with { type: "json" };

afterEach(() => vi.restoreAllMocks());

const caller = {
  plugin: "rewards",
  source: "cicord",
  bot: "community",
  instance: "rewards",
  verified: true,
};
type Call = { method: string; input: Json; key: string };
/** A tickets provider whose next outcomes are scripted; every call is recorded. */
function provider(installed = () => true) {
  const calls: Call[] = [];
  const outcomes: (Error | undefined)[] = [];
  const plugins: Context["plugins"] = {
    has: (name: string) => name === "tickets" && installed(),
    hasFeature: () => false,
    query: async () => {
      throw new Error("unexpected query");
    },
    call: (async (
      _plugin: string,
      method: string,
      input: Json,
      opts: { idempotencyKey: string },
    ) => {
      calls.push({ method, input, key: opts.idempotencyKey });
      const next = outcomes.shift();
      if (next) throw next;
      return { id: "7" };
    }) as Context["plugins"]["call"],
  };
  return { calls, outcomes, plugins };
}
function shop(p: ReturnType<typeof provider>) {
  return createTestContext({
    schema,
    config: { enabled: true, shop: [{ id: "vip", label: "VIP help", price: 30, type: "perk" }] },
    features: ["perk"],
    plugins: p.plugins,
    members: [{ id: "1" }],
    locales: { en },
  });
}
/** Runs /buy with a fixed interaction id, as a redelivered interaction would. */
async function buy(h: TestHarness, id: string) {
  const declared = plugin.commands!.buy!;
  const run = declared.run!;
  return runCommand(
    { commands: { buy: { ...declared, run: (ctx, i) => run(ctx, { ...i, id }) } } },
    h,
    "buy",
    { user: "1", options: { item: "vip" } },
  );
}
async function drain(h: TestHarness) {
  for (let n = 0; n < 50 && h.scheduled.length; n++) {
    const task = h.scheduled.shift()!;
    await plugin.tasks![task.task]!(h.ctx, task.payload);
  }
}
const order = (h: TestHarness, id: string) => h.kv.get("order:1:" + id) as { state: string };
const pendingRows = (h: TestHarness) => [...h.kv.keys()].filter((k) => k.startsWith("pend:"));

test("a perk is delivered inside /buy with the order key, and a replayed /buy charges once", async () => {
  const p = provider(),
    h = shop(p);
  await transact(h.ctx, "seed", [{ userId: "1", amount: 100 }], "seed");
  const first = await buy(h, "900");
  expect(first.deferred).toEqual({ ephemeral: true });
  expect(first.replies).toEqual([en["bought.delivered"].replace("{id}", "vip")]);
  expect(p.calls).toEqual([
    {
      method: "open",
      key: "order:900",
      input: { userId: "1", subject: "VIP help", description: "Shop order 900" },
    },
  ]);
  await buy(h, "900");
  expect(h.kv.get("balance:1")).toBe(70);
  expect(order(h, "900").state).toBe("delivered");
  expect(pendingRows(h)).toEqual([]);
});

test("a definitive refusal refunds in the same commit as the order state and journal row", async () => {
  const p = provider(),
    h = shop(p);
  await transact(h.ctx, "seed", [{ userId: "1", amount: 100 }], "seed");
  p.outcomes.push(new InteropError("denied", "Ticket author required"));
  const r = await buy(h, "901");
  expect(r.replies).toEqual([en["bought.refunded"].replace("{id}", "vip")]);
  expect(h.kv.get("balance:1")).toBe(100);
  expect(order(h, "901").state).toBe("refunded");
  expect(h.kv.get("ledger:1:refund:901")).toMatchObject({ amount: 30, reason: "refund vip" });
  expect(pendingRows(h)).toEqual([]);
  // Replaying the purchase neither charges, calls nor refunds again.
  await buy(h, "901");
  expect(p.calls).toHaveLength(1);
  expect(h.kv.get("balance:1")).toBe(100);
});

test("an ambiguous failure stays pending; the cron never calls tickets; the member retries with the same key", async () => {
  const p = provider(),
    h = shop(p);
  await transact(h.ctx, "seed", [{ userId: "1", amount: 100 }], "seed");
  const status = vi.spyOn(h.ctx.status, "set");
  p.outcomes.push(new InteropError("handler_error", "provider timed out"));
  const r = await buy(h, "902");
  expect(r.replies).toEqual([en["bought.pending"].replaceAll("{id}", "vip")]);
  expect(order(h, "902").state).toBe("pending");
  expect(status).toHaveBeenCalledWith("orders", expect.stringContaining("Undelivered vip order"));
  // Background passes (cron and fulfill tasks) carry no principal and must not open the ticket.
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 120_000);
  await plugin.schedules!.orders!.run(h.ctx);
  await drain(h);
  expect(p.calls).toHaveLength(1);
  expect(order(h, "902").state).toBe("pending");
  // A second /buy of the same product retries the pending order instead of charging again.
  await buy(h, "903");
  expect(h.kv.get("order:1:903")).toBeUndefined();
  expect(p.calls.map((c) => c.key)).toEqual(["order:902", "order:902"]);
  expect(p.calls[1]!.input).toEqual(p.calls[0]!.input);
  expect(order(h, "902").state).toBe("delivered");
  expect(h.kv.get("balance:1")).toBe(70);
  // The redirected interaction stays idempotent after the order it joined was delivered.
  await buy(h, "903");
  expect(h.kv.get("balance:1")).toBe(70);
  expect(p.calls).toHaveLength(2);
  expect(await plugin.privacy!.export(h.ctx, "1")).toContainEqual({
    key: "alias:1:903",
    value: "order:1:902",
  });
});

test("an undelivered perk is refunded after the window, but never during a live attempt", async () => {
  const p = provider(),
    h = shop(p);
  await transact(h.ctx, "seed", [{ userId: "1", amount: 100 }], "seed");
  const start = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(start);
  p.outcomes.push(new Error("Discord unavailable"));
  await buy(h, "904");
  expect(order(h, "904").state).toBe("pending");
  // The window has passed, but an attempt started a few seconds ago: no refund yet.
  const late = start + DELIVERY_HOURS * 3_600_000;
  const entry = (await h.ctx.kv.getEntry("order:1:904"))!;
  await h.ctx.kv.set("order:1:904", { ...(entry.value as object), attemptAt: late - 5_000 });
  clock.mockReturnValue(late);
  await plugin.tasks!.fulfill!(h.ctx, { key: "order:1:904" });
  expect(order(h, "904").state).toBe("pending");
  clock.mockReturnValue(late + 61_000);
  await plugin.schedules!.orders!.run(h.ctx);
  await drain(h);
  expect(order(h, "904").state).toBe("refunded");
  expect(h.kv.get("balance:1")).toBe(100);
  expect(p.calls).toHaveLength(1);
  expect(pendingRows(h)).toEqual([]);
  // Once no order is pending, the next pass clears the staff line.
  const status = vi.spyOn(h.ctx.status, "set");
  await plugin.schedules!.orders!.run(h.ctx);
  expect(status).toHaveBeenCalledWith("orders", null);
});

test("a pending order whose provider vanished is refunded by the next background pass", async () => {
  let installed = true;
  const p = provider(() => installed),
    h = shop(p);
  await transact(h.ctx, "seed", [{ userId: "1", amount: 100 }], "seed");
  p.outcomes.push(new InteropError("timeout", "provider timed out"));
  await buy(h, "905");
  installed = false;
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 120_000);
  await plugin.schedules!.orders!.run(h.ctx);
  await drain(h);
  expect(order(h, "905").state).toBe("refunded");
  expect(h.kv.get("balance:1")).toBe(100);
});

test("the portal checkout delivers inline and its retry uses the same order key", async () => {
  const p = provider(),
    h = shop(p);
  await transact(h.ctx, "seed", [{ userId: "1", amount: 100 }], "seed");
  const body = { purchaseId: "cdfad0ee-53c9-45eb-a106-d522cc34ccf6" };
  p.outcomes.push(new InteropError("handler_error", "busy"));
  const first = await callRoute(plugin, h, "POST /shop/vip/buy", { viewer: "1", body });
  expect(first.body).toMatchObject({ state: "pending" });
  const retry = await callRoute(plugin, h, "POST /inventory/deliver", { viewer: "1" });
  expect(retry.body).toEqual({
    items: [{ orderId: "portal:1:" + body.purchaseId, itemId: "vip", state: "delivered" }],
  });
  expect(new Set(p.calls.map((c) => c.key))).toEqual(
    new Set(["order:portal:1:" + body.purchaseId]),
  );
  expect(h.kv.get("balance:1")).toBe(70);
});

test("debit requires the debited member as the principal", async () => {
  const h = createTestContext({ schema, config: { enabled: true }, locales: { en } });
  await transact(h.ctx, "seed", [{ userId: "1", amount: 100 }], "seed");
  const debit = (onBehalfOf?: { userId: string; access: "member" | "scoped" }) =>
    plugin.actions!.debit!.run(
      h.ctx,
      { userId: "1", amount: 10 },
      { caller, idempotencyKey: "k" + Math.random(), ...(onBehalfOf ? { onBehalfOf } : {}) },
    );
  for (const who of [
    undefined,
    { userId: "2", access: "member" as const },
    { userId: "1", access: "scoped" as const },
  ])
    await expect(debit(who)).rejects.toMatchObject({ name: "InteropError", code: "denied" });
  expect(h.kv.get("balance:1")).toBe(100);
  expect(await debit({ userId: "1", access: "member" })).toEqual({ balance: 90 });
});

test("idempotency receipts survive erasure and journal expiry, and stay per member", async () => {
  const h = createTestContext({
    schema,
    config: { enabled: true, earnings: { attendee: 5 } },
    features: ["eventRewards"],
    locales: { en },
  });
  const call = { caller, idempotencyKey: "gw:1:1:points" };
  const credit = () => plugin.actions!.credit!.run(h.ctx, { userId: "1", amount: 100 }, call);
  expect(await credit()).toEqual({ balance: 100 });
  await plugin.privacy!.erase(h.ctx, "1");
  expect(await plugin.privacy!.export(h.ctx, "1")).toEqual([]);
  expect(await credit()).toEqual({ balance: 0 });
  expect(h.kv.get("balance:1")).toBeUndefined();
  // Receipts hold no member id.
  for (const [k, v] of h.kv)
    if (k.startsWith("rcpt:")) expect(k + JSON.stringify(v)).not.toContain(":1");
  // Journal expiry: the ledger rows disappear, the receipt still blocks the replay.
  const event = plugin.subscriptions!["community-events.ended"]!;
  const meta = {
    id: "evt-1",
    topic: "community-events.ended",
    version: 1,
    at: "",
    publisher: { plugin: "community-events", bot: "b", instance: "i" },
  };
  await event(h.ctx, { attendees: ["2", "3"] }, meta);
  await drain(h);
  expect([h.kv.get("balance:2"), h.kv.get("balance:3")]).toEqual([5, 5]);
  for (const k of [...h.kv.keys()]) if (k.startsWith("ledger:")) h.kv.delete(k);
  await event(h.ctx, { attendees: ["2", "3"] }, meta);
  await drain(h);
  expect([h.kv.get("balance:2"), h.kv.get("balance:3")]).toEqual([5, 5]);
});

test("leaving and rejoining voice leaves exactly one live reward chain", async () => {
  const h = createTestContext({
    schema,
    config: { enabled: true, earnings: { voice: 1 }, dailyCap: 0 },
    features: ["voiceRewards"],
    members: [{ id: "1" }],
    channels: { lounge: { name: "lounge", type: "voice" } },
    locales: { en },
  });
  const voice = plugin.events!.voiceStateUpdate!;
  for (let n = 0; n < 10; n++) {
    await voice(h.ctx, h.setVoice("1", "lounge"));
    await voice(h.ctx, h.setVoice("1", null));
  }
  await voice(h.ctx, h.setVoice("1", "lounge"));
  expect(h.scheduled.filter((t) => t.task === "voice")).toHaveLength(11);
  const queued = h.scheduled.splice(0);
  for (const t of queued) await plugin.tasks!.voice!(h.ctx, t.payload);
  expect(h.scheduled.filter((t) => t.task === "voice")).toHaveLength(1);
  // A session stored before join tokens existed (a bare channel id) does not block a new chain.
  const lounge = h.voiceChannel("1")!;
  h.scheduled.splice(0);
  await h.ctx.kv.set("voice:1", lounge);
  await voice(h.ctx, h.setVoice("1", "lounge"));
  expect(h.scheduled.filter((t) => t.task === "voice")).toHaveLength(1);
});

test("status lines name the missing grant or partner of products and reward sources", async () => {
  const h = createTestContext({
    schema,
    config: {
      enabled: true,
      earnings: { message: 1, level: 5, poll: 2 },
      shop: [
        { id: "vip", label: "VIP", price: 3, type: "perk" },
        { id: "tmp", label: "Temp", price: 3, type: "temporary", role: "r" },
      ],
    },
    features: ["eventRewards", "temporaryRole"],
    plugins: {
      has: (n: string) => n === "polls",
      hasFeature: () => false,
    } as unknown as Context["plugins"],
    locales: { en },
  });
  const status = vi.spyOn(h.ctx.status, "set");
  await plugin.onStart!(h.ctx);
  const line = (key: string) => status.mock.calls.find((c) => c[0] === key)?.[1];
  expect(line("shop-products")).toBe(
    "Unavailable shop products: vip (perk not granted (plugins.call:tickets.open)); tmp (member-roles not installed)",
  );
  expect(line("rewards")).toContain("message (messageRewards");
  expect(line("rewards")).toContain("level (levels not installed)");
  expect(line("rewards")).toContain("pollPages");
  expect(line("rewards")).not.toContain("poll (polls not installed)");
});

test("a truncated poll without pollPages pays the carried voters and reports instead of throwing", async () => {
  const h = createTestContext({
    schema,
    config: { enabled: true, earnings: { poll: 2 } },
    features: ["eventRewards"],
    locales: { en },
  });
  const status = vi.spyOn(h.ctx.status, "set");
  const meta = {
    id: "poll-1",
    topic: "polls.closed",
    version: 2,
    at: "",
    publisher: { plugin: "polls", bot: "b", instance: "i" },
  };
  await plugin.subscriptions!["polls.closed"]!(
    h.ctx,
    { pollId: "p", voters: ["4"], votersTruncated: true },
    meta,
  );
  expect(h.kv.get("balance:4")).toBe(2);
  expect(status).toHaveBeenCalledWith("poll-voters", expect.stringContaining("pollPages"));
});
