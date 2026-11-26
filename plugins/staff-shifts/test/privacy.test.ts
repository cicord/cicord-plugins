import { expect, test, vi, afterEach, beforeEach } from "vite-plus/test";
import { createTestContext, runCommand, callRoute } from "@cicord/sdk/testing";
import type { Json } from "@cicord/sdk";
import schema from "../config.schema.json" with { type: "json" };
import en from "../locales/en.json" with { type: "json" };
import fr from "../locales/fr.json" with { type: "json" };
// The publisher's real contract: the runtime validates every delivery against it.
import caseV2 from "../../moderation/contracts/case.v2.json" with { type: "json" };
import plugin from "../src/index.ts";

type Schema = {
  type?: string | string[];
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean;
  minimum?: number;
};
/** The JSON Schema subset the published contracts use (type, properties, required, minimum). */
function violations(s: Schema, v: unknown, at = "$"): string[] {
  const kind =
    v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v;
  const types = s.type === undefined ? [] : ([] as string[]).concat(s.type);
  if (types.length && !types.includes(kind) && !(kind === "integer" && types.includes("number")))
    return [`${at}: ${kind} is not ${types.join("|")}`];
  const out: string[] = [];
  if (typeof v === "number" && s.minimum !== undefined && v < s.minimum) out.push(at + ": minimum");
  if (kind === "object") {
    const o = v as Record<string, unknown>;
    for (const r of s.required ?? []) if (!(r in o)) out.push(`${at}.${r}: required`);
    for (const [k, val] of Object.entries(o)) {
      const sub = s.properties?.[k];
      if (sub) out.push(...violations(sub, val, `${at}.${k}`));
      else if (s.additionalProperties === false) out.push(`${at}.${k}: not allowed`);
    }
  }
  return out;
}
const meta = (id: string, topic: string, version: number) => ({
  id,
  topic,
  version,
  at: new Date().toISOString(),
  publisher: { plugin: topic.split(".")[0]!, instance: topic.split(".")[0]!, bot: "b" },
});
const moderationCase = (moderator: Json) => ({
  number: 4,
  action: "warn",
  at: new Date().toISOString(),
  reason: "spam",
  member: { id: "2", name: "member" },
  moderator,
  status: "active",
  source: { type: moderator ? "command" : "escalation" },
});

function setup() {
  const t = createTestContext({
    schema,
    locales: { en, fr },
    config: { staffRole: "staff", dutyRole: "duty", maxHours: 4, reminderMinutes: 15 },
    features: ["reminders", "statistics"],
    roles: { staff: { name: "Staff" }, duty: { name: "Duty" } },
    members: [{ id: "1", roles: ["staff"] }, { id: "2" }, { id: "3", roles: ["staff"] }],
  });
  return t;
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse("2026-03-02T08:00:00Z"));
});
afterEach(() => vi.useRealTimers());

test("moderation.case v2 deliveries that match the published contract count per moderator once", async () => {
  const t = setup();
  const staffCase = moderationCase({ id: "1", name: "alice" }),
    automatic = moderationCase(null),
    memberCase = moderationCase({ id: "2", name: "bob" });
  for (const payload of [staffCase, automatic, memberCase])
    expect(violations(caseV2 as Schema, payload)).toEqual([]);
  // The validator is not vacuous: the shape the old code expected is rejected by the contract.
  expect(violations(caseV2 as Schema, { ...staffCase, moderator: "1" })).not.toEqual([]);

  const deliver = plugin.subscriptions!["moderation.case"]!;
  await deliver(t.ctx, staffCase, meta("case-1", "moderation.case", 2));
  await deliver(t.ctx, staffCase, meta("case-1", "moderation.case", 2)); // replay
  await deliver(
    t.ctx,
    moderationCase({ id: "1", name: "alice" }),
    meta("case-2", "moderation.case", 2),
  );
  await deliver(t.ctx, automatic, meta("case-3", "moderation.case", 2));
  await deliver(t.ctx, memberCase, meta("case-4", "moderation.case", 2)); // not staff
  expect((await callRoute(plugin, t, "GET /me", { viewer: "1" })).body).toMatchObject({ case: 2 });
  expect(t.kv.get("case:2")).toBeUndefined();
});

async function populate(t: ReturnType<typeof setup>, id: string, n: number) {
  await runCommand(plugin, t, "duty on", { user: id });
  const plan = { zone: "Europe/Paris", shifts: [{ day: 3, start: 540, minutes: 60 }] };
  expect((await callRoute(plugin, t, "PUT /me/plan", { viewer: id, body: plan })).status).toBe(200);
  await plugin.subscriptions!["tickets.closed"]!(
    t.ctx,
    { assignee: id },
    meta("ticket-" + n, "tickets.closed", 1),
  );
  await plugin.subscriptions!["moderation.case"]!(
    t.ctx,
    moderationCase({ id, name: "staff " + id }),
    meta("case-" + n, "moderation.case", 2),
  );
}
const keysOf = (t: ReturnType<typeof setup>, id: string) => {
  const ref = t.kv.get("subjectFor:" + id) as string | undefined;
  return [...t.kv.keys()].filter(
    (k) =>
      k.endsWith(":" + id) ||
      k.startsWith("receipt:" + id + ":") ||
      (ref !== undefined && k === "subject:" + ref),
  );
};
const snapshot = (t: ReturnType<typeof setup>, id: string) =>
  Object.fromEntries(keysOf(t, id).map((k) => [k, t.kv.get(k)]));

test("export and erase of one staff member leave the other member's records intact", async () => {
  const t = setup();
  await populate(t, "1", 1);
  await populate(t, "3", 2);
  const before3 = snapshot(t, "3");
  // duty, plan, ticket and case totals, two receipts, and the timer subject reference pair
  expect(Object.keys(before3)).toHaveLength(8);
  const exported = (await plugin.privacy!.export(t.ctx, "1")) as Record<string, Json>;
  expect(exported).toMatchObject({
    duty: { owned: true },
    plan: { zone: "Europe/Paris" },
    ticket: 1,
    case: 1,
    receipts: ["receipt:1:case-1", "receipt:1:ticket-1"],
  });
  expect(JSON.stringify(exported)).not.toContain('"3"');
  const tasks1 = t.scheduled.filter((s) => {
    const ref = (s.payload as { ref?: string } | undefined)?.ref;
    return ref === t.kv.get("subjectFor:1");
  });
  expect(tasks1.map((s) => s.task).sort()).toEqual(["expire", "remind"]);

  const { erased } = await t.eraseMember(plugin, "1");
  expect(erased).toBeGreaterThanOrEqual(6);
  expect(keysOf(t, "1")).toEqual([]);
  expect(t.member("1")!.hasRole("duty")).toBe(false);
  for (const task of tasks1) expect(t.scheduled.some((s) => s.id === task.id)).toBe(false);
  expect(await plugin.privacy!.export(t.ctx, "1")).toEqual({ receipts: [] });
  expect(snapshot(t, "3")).toEqual(before3);
  expect(t.member("3")!.hasRole("duty")).toBe(true);
  expect((await callRoute(plugin, t, "GET /me", { viewer: "3" })).body).toMatchObject({
    ticket: 1,
    case: 1,
  });
});

test("a departing staff member's duty, schedule, statistics and receipts are erased on memberLeave", async () => {
  const t = setup();
  await populate(t, "1", 1);
  await populate(t, "3", 2);
  const before1 = snapshot(t, "1"),
    user = t.member("3")!.user;
  t.removeMember("3");
  await plugin.events!.memberLeave!(t.ctx, user);
  expect(keysOf(t, "3")).toEqual([]);
  expect(t.kv.has("duration:3")).toBe(false);
  expect(t.scheduled.filter((s) => s.task === "remind")).toHaveLength(1);
  expect(snapshot(t, "1")).toEqual(before1);
  // A replayed departure is harmless.
  await plugin.events!.memberLeave!(t.ctx, user);
  expect(snapshot(t, "1")).toEqual(before1);
});
