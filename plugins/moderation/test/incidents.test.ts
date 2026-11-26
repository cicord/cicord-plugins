import { expect, test } from "vite-plus/test";
import { callRoute, createTestContext } from "@cicord/sdk/testing";
import type { InteropCall, Json } from "@cicord/sdk";
import plugin from "../src/index.ts";
import schema from "../config.schema.json" with { type: "json" };
import { quarantine, release, trackQuarantine } from "../src/quarantine.ts";
import { indexCase, type Case } from "../src/moderation.ts";
import { migrateCases } from "../src/cases.ts";

const caller: InteropCall["caller"] = {
  plugin: "guard",
  bot: "security",
  instance: "guard",
  source: "cicord",
  verified: true,
};
function setup() {
  return createTestContext({
    schema,
    features: ["appeals", "quarantine", "lock"],
    config: {
      logChannel: "log",
      appeals: { enabled: true },
      quarantineRole: "restricted",
      escalation: [],
    },
    server: { ownerId: "owner" },
    access: { moderators: { roles: ["staff"] } },
    roles: {
      botTop: { name: "Bot", position: 20 },
      staff: { name: "Staff", position: 10 },
      restricted: { name: "Restricted", position: 2 },
      member: { name: "Member", position: 1 },
      extra: { name: "Extra", position: 3 },
      listed: { name: "Listed", position: 4, holders: ["holder"] },
    },
    members: [
      { id: "bot", roles: ["botTop"], bot: true },
      { id: "staffer", roles: ["staff"] },
      { id: "member", roles: ["member"] },
      { id: "holder", roles: ["listed"] },
    ],
    channels: { log: { name: "Staff log" } },
  });
}
const c = (number: number, action: Case["action"] = "warn"): Case => ({
  number,
  action,
  member: { id: "member", name: "Alice" },
  moderator: { id: "staffer", name: "Staff" },
  reason: "Reason",
  at: new Date().toISOString(),
  evidence: "https://private.invalid/attachment",
});
test("member-safe projection includes legacy and new cases, while staff retain private evidence and notes", async () => {
  const t = setup();
  for (const item of [c(1), { ...c(2), status: "active" as const }, c(3, "note")]) {
    await t.ctx.kv.set("case:" + item.number, item);
    await indexCase(t.ctx, item);
  }
  await migrateCases(t.ctx);
  const own = await callRoute(plugin, t, "GET /members/member", { viewer: "member" });
  expect(own.status).toBe(200);
  expect(JSON.stringify(own.body)).not.toMatch(/staffer|private.invalid|note|evidence/);
  expect(own.body).toMatchObject({ items: [{ number: 2 }, { number: 1 }] });
  const staff = await callRoute(plugin, t, "GET /members/member", { viewer: "staffer" });
  expect(JSON.stringify(staff.body)).toContain("private.invalid");
  expect(JSON.stringify(staff.body)).toContain('"note"');
  // Index migration never writes the source record.
  expect(await t.ctx.kv.get("case:1")).toEqual(cachedLegacy(await t.ctx.kv.get<Case>("case:1")));
  function cachedLegacy(v: Case | undefined) {
    if (!v) return undefined;
    const { status: _, source: __, ...rest } = v;
    return rest;
  }
});
test("a signed case admits one appeal; a newer warning survives the older decision", async () => {
  const t = setup();
  for (const n of [1, 2]) {
    await t.ctx.kv.set("case:" + n, { ...c(n), status: "active" });
    await t.ctx.kv.set("warn:member:" + String(n).padStart(8, "0"), { case: n });
  }
  const link = await t.ctx.portal.link("/appeals", {
    user: "member",
    scope: { kind: "case", id: "1" },
    expiresInSeconds: 60,
  });
  const body = { text: "Please review" };
  const call = { viewer: "member", scopedLink: link, body };
  expect((await callRoute(plugin, t, "POST /appeals", { ...call, viewer: "holder" })).status).toBe(
    403,
  );
  expect(
    (await callRoute(plugin, t, "POST /appeals", { ...call, body: { ...body, case: 2 } })).status,
  ).toBe(403);
  const requests = await Promise.all([
    callRoute(plugin, t, "POST /appeals", call),
    callRoute(plugin, t, "POST /appeals", call),
  ]);
  expect(requests.map((r) => r.status)).toEqual([200, 200]);
  expect((await t.ctx.kv.list({ prefix: "appeal:" })).items).toHaveLength(1);
  const reply = await callRoute(plugin, t, "POST /appeals/1/decision", {
    viewer: "staffer",
    body: { decision: "accepted" },
  });
  expect(reply.status).toBe(200);
  expect(await t.ctx.kv.get("warn:member:00000001")).toBeUndefined();
  expect(await t.ctx.kv.get("warn:member:00000002")).toBeDefined();
  expect((await callRoute(plugin, t, "GET /appeal", call)).status).toBe(403);
});
test("quarantine renewal ignores a stale task, preserves staff additions and excludes a removed saved role", async () => {
  const t = setup(),
    m = t.member("member")!;
  const first = await quarantine(t.ctx, m, "test", 60, null, { type: "command" });
  const second = await quarantine(t.ctx, m, "extension", 120, null, { type: "command" });
  expect(await release(t.ctx, m.id, first.number, null, "old", true)).toBe(false);
  expect(m.hasRole("restricted")).toBe(true);
  // A moderator added a role during the restriction, then explicitly removed
  // the original membership after temporarily re-granting it.
  const before = { ...m, roles: [...m.roles] };
  await m.addRole("extra");
  await trackQuarantine(t.ctx, m, before);
  await m.addRole("member");
  await trackQuarantine(t.ctx, m, { ...m, roles: m.roles.filter((x) => x.key !== "member") });
  const withMember = { ...m, roles: [...m.roles] };
  await m.removeRole("member");
  await trackQuarantine(t.ctx, m, withMember);
  expect(await release(t.ctx, m.id, second.number, null, "done")).toBe(true);
  expect(m.hasRole("extra")).toBe(true);
  expect(m.hasRole("member")).toBe(false);
  expect(m.hasRole("restricted")).toBe(false);
});
test("interop refuses untrusted staff targets and ordinary on-behalf-of authority, and applies sourced warnings", async () => {
  const t = setup(),
    run = plugin.actions!.sanction!.run;
  const req = { userId: "staffer", action: "warn", reason: "test" };
  await expect(run(t.ctx, req, { caller, idempotencyKey: "one" })).rejects.toMatchObject({
    code: "denied",
  });
  await expect(
    run(
      t.ctx,
      { ...req, userId: "member" },
      { caller, onBehalfOf: { userId: "member", access: "member" }, idempotencyKey: "two" },
    ),
  ).rejects.toMatchObject({ code: "denied" });
  const out = (await run(
    t.ctx,
    { ...req, userId: "member" },
    { caller, idempotencyKey: "three" },
  )) as Json;
  expect(out).toMatchObject({ action: "warn", number: 1 });
  expect(await t.ctx.kv.get("case:1")).toMatchObject({
    source: { type: "plugin", plugin: "guard", caller },
  });
});

test("appeal renewal sends one DM per case and erasure preserves other members", async () => {
  const t = setup(),
    current = { ...c(1), status: "active" as const };
  await t.ctx.kv.set("case:1", current);
  const other = { ...c(2), member: { id: "holder", name: "Bob" } };
  await t.ctx.kv.set("case:2", other);
  await t.ctx.kv.set("case:3", c(3, "note"));
  await indexCase(t.ctx, current);
  const link = await t.ctx.portal.link("/appeals", {
    user: "member",
    scope: { kind: "case", id: "1" },
    expiresInSeconds: 60,
  });
  const call = { viewer: "member", scopedLink: link };
  expect((await callRoute(plugin, t, "POST /scope/renew", call)).status).toBe(200);
  expect((await callRoute(plugin, t, "POST /scope/renew", call)).status).toBe(429);
  expect(t.sent.filter((m) => m.to === "dm:member")).toHaveLength(1);
  await callRoute(plugin, t, "POST /appeals", { ...call, body: { text: "private appeal" } });
  const exported = await plugin.privacy!.export(t.ctx, "member");
  expect(JSON.stringify(exported)).toContain("private appeal");
  expect(JSON.stringify(exported)).not.toContain("Bob");
  await plugin.privacy!.erase(t.ctx, "member");
  expect(await t.ctx.kv.get("case:2")).toEqual(other);
  expect(await t.ctx.kv.get("case:3")).toBeUndefined();
  expect(await t.ctx.kv.get("appeal:1")).toBeUndefined();
  const redacted = await t.ctx.kv.get<Case>("case:1");
  expect(redacted?.member?.id).toMatch(/^deleted-user-/);
  expect(redacted?.reason).toBe("");
  expect(redacted?.evidence).toBeUndefined();
  expect((await callRoute(plugin, t, "GET /appeal", call)).status).toBe(403);
});

test("a staff decision on an older ban never releases the current ban", async () => {
  const t = setup(),
    first = { ...c(1, "ban"), status: "active" as const };
  await t.ctx.kv.set("case:1", first);
  await t.ctx.kv.set("case:2", { ...c(2, "ban"), status: "active" });
  await t.ctx.kv.set("active-ban:member", 2);
  await t.ctx.kv.set("appeal:1", {
    case: 1,
    userId: "member",
    text: "review old case",
    status: "pending",
    submittedAt: new Date().toISOString(),
  });
  const decision = await callRoute(plugin, t, "POST /appeals/1/decision", {
    viewer: "staffer",
    body: { decision: "accepted" },
  });
  expect(decision.status).toBe(200);
  expect(decision.body).toMatchObject({
    resolution: "sanction absent, expired, superseded or unverifiable",
  });
  expect(await t.ctx.kv.get("active-ban:member")).toBe(2);
  expect(t.moderation.filter((a) => a.action === "unban")).toHaveLength(0);
});
