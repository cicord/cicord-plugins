import type { AuditLogEntry, MessagePayload } from "@cicord/sdk";
import { createTestContext, callRoute } from "@cicord/sdk/testing";
import { beforeEach, afterEach, expect, test, vi } from "vite-plus/test";
import en from "../locales/en.json" with { type: "json" };
import fr from "../locales/fr.json" with { type: "json" };
import schema from "../config.schema.json" with { type: "json" };
import plugin from "../src/index.ts";
import { deadline } from "../src/deletions.ts";
import { migrate, housekeeping } from "../src/log.ts";

const staff = {
  allow: ["ViewChannel", "ReadMessageHistory"] as ("ViewChannel" | "ReadMessageHistory")[],
};
function setup(config: Record<string, unknown> = {}, locale = "en") {
  const t = createTestContext({
    config: { channel: "audit", ...config },
    schema,
    locales: { en, fr },
    locale,
    server: { id: "42", preferredLocale: locale },
    roles: { staff: { name: "Staff" }, private: { name: "Private" } },
    access: { moderators: { roles: ["staff"] } },
    channels: {
      audit: { name: "log", overwrites: { staff } },
      secret: { name: "secret", overwrites: { private: staff } },
      open: { name: "open", overwrites: { "@everyone": staff } },
    },
    members: [
      { id: "110", username: "Alice" },
      { id: "220", username: "Bob" },
      { id: "990", username: "Mia", roles: ["staff", "private"] },
      { id: "880", username: "Tom", roles: ["staff"] },
    ],
  });
  // Each fixture models grants separately from its config switches.
  const features = new Set([
    "search",
    "partners",
    ...(config.cacheContent ? ["cacheContent"] : []),
  ]);
  Object.assign(t.ctx, { features: { enabled: (name: string) => features.has(name) } });
  const diagnostics = new Map<string, string>();
  Object.assign(t.ctx, {
    status: {
      set: (k: string, msg: string | null) => {
        if (msg) diagnostics.set(k, msg);
        else diagnostics.delete(k);
      },
    },
  });
  return Object.assign(t, { features, diagnostics });
}
type T = ReturnType<typeof setup>;
const events = plugin.events!;
const sent = (t: T) =>
  t.sent
    .filter((s) => s.to === "audit")
    .map((s) => (s.message as MessagePayload).embeds?.[0]?.description ?? "");
const tick = (ms: number) => vi.setSystemTime(Date.now() + ms);
async function seen(t: T, id: string, author = "110", body = "hidden words") {
  const channel = t.ctx.server.channel("secret");
  const m = { ...(await channel.send(body)), id, author: t.member(author)!.user };
  await events.messageCreate!(t.ctx, m);
  return m;
}
const del = (t: T, id: string) =>
  events.messageDelete!(t.ctx, { id, channel: t.ctx.server.channel("secret") });
const proof = (
  t: T,
  id: string,
  actor: string,
  count: number,
  message?: string,
): AuditLogEntry => ({
  id,
  at: new Date(),
  action: "message.delete",
  actorId: actor,
  actor: t.member(actor)!.user,
  targetId: "110",
  targetType: "member",
  options: {
    channel_id: t.ctx.server.channel("secret").id,
    count: String(count),
    ...(message ? { message_id: message } : {}),
  },
  changes: [],
  mergeable: true,
  attribution: { kind: "human", certainty: "confirmed" },
});
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-20T12:00:00Z"));
});
afterEach(() => vi.useRealTimers());

test("the first audit fact arrives promptly, merged counts are probable and replays do not duplicate either", async () => {
  const t = setup();
  await seen(t, "101");
  await del(t, "101");
  expect(sent(t)).toEqual([]);
  tick(6000);
  const start = Date.now(),
    e = proof(t, "9001", "990", 1);
  await events.auditLogEntry!(t.ctx, e);
  expect(Date.now() - start).toBeLessThan(10_000);
  expect(sent(t)).toEqual([expect.stringContaining("Confirmed audit entry: Mia")]);
  expect(sent(t)[0]).toContain("Discord did not identify the message");
  await events.auditLogEntry!(t.ctx, e);
  await del(t, "101");
  expect(sent(t)).toHaveLength(1);
  tick(1000);
  await seen(t, "102");
  await del(t, "102");
  await events.auditLogEntry!(t.ctx, proof(t, "9001", "990", 2));
  expect(sent(t)[1]).toContain("Probable attribution: Mia");
  expect(sent(t)[1]).toContain("merged count 2");
});
test("audit-first delivery and two competing moderators never invent a per-message actor", async () => {
  const t = setup();
  await events.auditLogEntry!(t.ctx, proof(t, "9001", "990", 1));
  await events.auditLogEntry!(t.ctx, proof(t, "9002", "880", 1));
  await seen(t, "100");
  await del(t, "100");
  const key = (await t.ctx.kv.list({ prefix: "pending:" })).items[0]!.key;
  tick(29_999);
  await deadline(t.ctx, key);
  expect(sent(t)).toEqual([]);
  tick(1);
  await deadline(t.ctx, key);
  expect(sent(t)).toEqual([expect.stringContaining("actor unknown")]);
  expect(sent(t)[0]).not.toMatch(/Mia|Tom/);
  const u = setup();
  await events.auditLogEntry!(u.ctx, proof(u, "9003", "990", 1, "101"));
  await seen(u, "101");
  await del(u, "101");
  expect(sent(u)[0]).toContain("deleted by Mia");
});
test("two deletions with one unbound audit fact remain unknown", async () => {
  const t = setup();
  for (const id of ["201", "202"]) {
    await seen(t, id);
    await del(t, id);
  }
  await events.auditLogEntry!(t.ctx, proof(t, "9100", "990", 1));
  expect(sent(t)).toEqual([]);
  tick(30_000);
  for (const p of (await t.ctx.kv.list({ prefix: "pending:" })).items) await deadline(t.ctx, p.key);
  expect(sent(t)).toHaveLength(2);
  expect(sent(t).every((v) => v.includes("actor unknown"))).toBe(true);
});
test("role permission differences identify the actor and only trusted attribution identifies Cicord", async () => {
  const t = setup();
  const e = {
    ...proof(t, "9001", "990", 1),
    action: "role.update",
    targetType: "role",
    targetId: "31",
    reason: "cicord: reconcile",
    changes: [
      {
        key: "permissions",
        addedPermissions: ["ManageChannels" as const],
        removedPermissions: ["BanMembers" as const],
      },
    ],
  };
  await events.auditLogEntry!(t.ctx, e);
  expect(sent(t)[0]).toMatch(/Mia.*added ManageChannels removed BanMembers/);
  expect(sent(t)[0]).not.toContain("via Cicord");
  await events.auditLogEntry!(t.ctx, {
    ...e,
    id: "9002",
    attribution: { kind: "cicord", certainty: "confirmed", revision: "abc123" },
  });
  expect(sent(t)[1]).toContain("via Cicord (revision abc123)");
});
test("content is opt-in, private text stays off Discord, search and exports reevaluate grants", async () => {
  const t = setup({ cacheContent: true });
  await seen(t, "101");
  await del(t, "101");
  await events.auditLogEntry!(t.ctx, proof(t, "9001", "990", 1));
  expect(sent(t)[0]).not.toContain("hidden words");
  for (const path of ["GET /search", "GET /export"] as const) {
    const read = async (id: string) =>
      JSON.stringify(
        (await callRoute(plugin, t, path, { viewer: id, query: { q: "hidden" } })).body,
      );
    expect(await read("990")).toContain("hidden words");
    expect(await read("880")).not.toContain("hidden words");
    await t.member("990")!.removeRole("private");
    expect(await read("990")).not.toContain("hidden words");
    await t.member("990")!.addRole("private");
  }
  const off = setup();
  await seen(off, "101");
  expect(JSON.stringify([...off.kv])).not.toContain("hidden words");
  const disabled = setup({ cacheContent: true });
  disabled.features.delete("cacheContent");
  await seen(disabled, "101");
  expect(JSON.stringify([...disabled.kv])).not.toContain("hidden words");
});
test("erasing one member edits a shared Discord batch, removes search rows and preserves the other's observation", async () => {
  const t = setup();
  await events.memberLeave!(t.ctx, t.member("110")!.user);
  await events.memberLeave!(t.ctx, t.member("220")!.user);
  await plugin.tasks!.flush!(t.ctx, undefined);
  await plugin.tasks!.flush!(t.ctx, undefined);
  expect(sent(t)).toHaveLength(1);
  expect(sent(t)[0]).toMatch(/Alice[\s\S]*Bob|Bob[\s\S]*Alice/);
  expect((await plugin.privacy!.erase(t.ctx, "110")).erased).toBeGreaterThan(0);
  const edited = JSON.stringify(t.edits.at(-1));
  expect(edited).toContain("Bob");
  expect(edited).not.toContain("Alice");
  expect(await plugin.privacy!.export(t.ctx, "110")).toEqual([]);
  expect(await plugin.privacy!.export(t.ctx, "220")).toHaveLength(1);
  tick(31 * 86400000);
  await housekeeping(t.ctx);
  expect(await plugin.privacy!.export(t.ctx, "220")).toEqual([]);
});
test("public log, incomplete source, ignored channels, disabled installation and missing partners fail closed", async () => {
  const t = setup({ channel: "open", batchSeconds: 0 });
  await events.memberLeave!(t.ctx, t.member("110")!.user);
  expect(t.sent).toHaveLength(0);
  expect(t.diagnostics.size).toBeGreaterThan(0);
  const off = setup({ enabled: false });
  await events.memberJoin!(off.ctx, off.member("110")!);
  expect(off.kv.size).toBe(0);
  const ignored = setup({ cacheContent: true, ignoredChannels: ["secret"] });
  await seen(ignored, "101");
  await del(ignored, "101");
  expect(ignored.kv.size).toBe(0);
  const independent = setup({ batchSeconds: 0 });
  independent.features.delete("partners");
  await plugin.subscriptions!["guard.raid"]!(
    independent.ctx,
    { state: "started" },
    {
      id: "isolated",
      topic: "guard.raid",
      version: 1,
      at: new Date().toISOString(),
      publisher: { plugin: "guard", bot: "bot", instance: "guard" },
    },
  );
  expect(sent(independent)).toHaveLength(0);
});
test("bounded migration resumes at its durable cursor; locale catalogs match", async () => {
  const t = setup({ batchSeconds: 0 }, "fr");
  for (let i = 0; i < 65; i++)
    await t.ctx.kv.set("q:" + String(i).padStart(3, "0"), { text: "legacy" });
  await migrate(t.ctx);
  expect(await t.ctx.kv.get("migration:cursor")).toBeTruthy();
  await migrate(t.ctx);
  await migrate(t.ctx);
  expect(await t.ctx.kv.get("meta:schema")).toBe(2);
  expect((await t.ctx.kv.list({ prefix: "q:" })).items).toEqual([]);
  expect(Object.keys(fr).sort()).toEqual(Object.keys(en).sort());
  await events.memberLeave!(t.ctx, t.member("110")!.user);
  expect(sent(t)[0]).toContain("a quitté");
});

test("REST-only merged update consumes just observed evidence and retry is idempotent", async () => {
  const t = setup();
  await seen(t, "1");
  await del(t, "1");
  await events.auditLogEntry!(t.ctx, proof(t, "9100", "990", 1));
  await seen(t, "2");
  await del(t, "2");
  const key = (await t.ctx.kv.list({ prefix: "pending:" })).items[0]!.key;
  vi.spyOn(t.ctx.server, "auditLog").mockResolvedValue([proof(t, "9100", "990", 2)]);
  await plugin.tasks!.probeDeletion!(t.ctx, { key, attempt: 1 });
  await plugin.tasks!.probeDeletion!(t.ctx, { key, attempt: 2 });
  expect(sent(t)).toHaveLength(2);
  expect(sent(t)[1]).toContain("Probable attribution");
});
test("a remote send acknowledged after a local failure is recovered by its message marker", async () => {
  const t = setup({ batchSeconds: 0 }),
    log = t.ctx.server.channel("audit");
  const send = log.send.bind(log);
  let first = true;
  vi.spyOn(log, "send").mockImplementation(async (payload) => {
    const m = await send(payload);
    if (first) {
      first = false;
      throw Error("lost response");
    }
    return m;
  });
  await expect(events.memberLeave!(t.ctx, t.member("110")!.user)).rejects.toThrow("lost response");
  expect((await t.ctx.kv.list({ prefix: "work:" })).items).toHaveLength(1);
  await plugin.tasks!.flush!(t.ctx, undefined);
  await plugin.tasks!.flush!(t.ctx, undefined);
  expect(sent(t)).toHaveLength(1);
  expect((await t.ctx.kv.list({ prefix: "work:" })).items).toHaveLength(0);
});

test("a multi-member moderation record preserves the other subject and clears identifying text", async () => {
  const t = setup({ batchSeconds: 0 });
  await plugin.subscriptions!["moderation.case"]!(
    t.ctx,
    {
      number: 1,
      action: "ban",
      member: { id: "110", name: "Alice" },
      moderator: { id: "990", name: "Mia" },
      reason: "sensitive",
    },
    {
      id: "origin1",
      topic: "moderation.case",
      version: 2,
      at: new Date().toISOString(),
      publisher: { plugin: "moderation", bot: "bot", instance: "moderation" },
    },
  );
  expect(await plugin.privacy!.export(t.ctx, "110")).toHaveLength(1);
  await plugin.privacy!.erase(t.ctx, "110");
  expect(await plugin.privacy!.export(t.ctx, "110")).toEqual([]);
  expect(await plugin.privacy!.export(t.ctx, "990")).toHaveLength(1);
  const edited = JSON.stringify(t.edits.at(-1));
  expect(edited).toContain("deleted-user-");
  expect(edited).toContain("<@990>");
  expect(edited).not.toMatch(/<@110>|sensitive/);
});
