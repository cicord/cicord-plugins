import type { AuditLogEntry } from "@cicord/sdk";
import { createTestContext, callRoute } from "@cicord/sdk/testing";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import en from "../locales/en.json" with { type: "json" };
import fr from "../locales/fr.json" with { type: "json" };
import schema from "../config.schema.json" with { type: "json" };
import plugin from "../src/index.ts";
import { audit, settle, structure } from "../src/monitor.ts";
const setup = () =>
  createTestContext({
    schema,
    config: { thresholds: { channelDelete: 1 } },
    server: { ownerId: "owner" },
    members: [{ id: "owner" }, { id: "a" }, { id: "b" }],
  });
function entry(
  id: string,
  target: string,
  actor: string,
  override: Partial<AuditLogEntry> = {},
): AuditLogEntry {
  return {
    id,
    at: new Date(),
    action: "channel.delete",
    targetId: target,
    actorId: actor,
    changes: [],
    mergeable: false,
    attribution: { kind: "human", certainty: "confirmed" },
    ...override,
  };
}
afterEach(() => vi.useRealTimers());
test("separate actors, conflicting entries, CORE-04 attribution and replay", async () => {
  vi.useFakeTimers();
  const t = setup(),
    now = Date.now();
  for (const target of ["good", "mixed", "healed", "probable", "absent"])
    await structure(t.ctx, "channelDelete", target);
  await audit(t.ctx, entry("1", "good", "a", { reason: "cicord: reconcile" }));
  await audit(t.ctx, entry("2", "mixed", "a"));
  await audit(t.ctx, entry("3", "mixed", "b"));
  await audit(
    t.ctx,
    entry("4", "healed", "bot", { attribution: { kind: "cicord", certainty: "confirmed" } }),
  );
  await audit(
    t.ctx,
    entry("5", "probable", "bot", { attribution: { kind: "cicord", certainty: "probable" } }),
  );
  vi.setSystemTime(now + 30001);
  for (const target of ["good", "mixed", "healed", "probable", "absent"]) {
    const key = "pair:channelDelete:" + target;
    await settle(t.ctx, key);
    await settle(t.ctx, key);
  }
  const events = t.published.map((x) => x.payload);
  expect(events).toHaveLength(4);
  expect(events.filter((e) => (e as Record<string, unknown>).actorId)).toEqual([
    expect.objectContaining({ actorId: "a", certainty: "confirmed", responses: [] }),
  ]);
  expect(events).toContainEqual(
    expect.objectContaining({ actorType: "cicord", certainty: "probable" }),
  );
  vi.setSystemTime(now + 45000);
  await audit(t.ctx, entry("6", "absent", "b"));
  expect(t.published.at(-1)?.payload).toMatchObject({ actorType: "unknown", responses: [] });
  expect(t.moderation).toEqual([]);
  expect(t.roleChanges).toEqual([]);
  expect((await callRoute(plugin, t, "GET /incidents", { viewer: "a" })).status).toBe(403);
  const b = await plugin.privacy!.export(t.ctx, "b");
  await plugin.privacy!.erase(t.ctx, "a");
  expect(await plugin.privacy!.export(t.ctx, "a")).toEqual({});
  expect(await plugin.privacy!.export(t.ctx, "b")).toEqual(b);
});
test("owner, configured trust and merged records cannot become confirmed targets", async () => {
  const t = setup();
  await audit(t.ctx, entry("x", "u", "owner", { action: "bot.add" }));
  await audit(t.ctx, entry("y", "u", "a", { action: "bot.add", mergeable: true }));
  expect(t.published).toHaveLength(1);
  expect(t.published[0]?.payload).toMatchObject({ actorType: "unknown", responses: [] });
});

describe("aggregation and would-have-done (defaults)", () => {
  const protection = {
    known: true,
    selfHeal: false,
    deletionProtection: true,
    paused: false,
    totalResources: 3,
    unmanaged: [],
  };
  const harness = (config: Record<string, unknown> = {}) =>
    createTestContext({
      schema,
      locales: { en, fr },
      config: { staffChannel: "staff", ...config },
      features: ["ownerDM"],
      channels: { staff: { name: "staff" } },
      server: { ownerId: "owner", protection },
      members: [{ id: "owner" }, { id: "a" }, { id: "b" }],
    });
  async function wave(t: ReturnType<typeof harness>, targets: string[], actor?: string) {
    const began = Date.now();
    for (const target of targets) {
      await structure(t.ctx, "channelDelete", target);
      if (actor) await audit(t.ctx, entry("e-" + target, target, actor));
    }
    vi.setSystemTime(began + 30001);
    for (const target of targets) await settle(t.ctx, "pair:channelDelete:" + target);
  }
  const alerts = (t: ReturnType<typeof harness>) =>
    [...t.kv.keys()].filter((k) => k.startsWith("alert:"));
  const staffPosts = (t: ReturnType<typeof harness>) => t.sent.filter((s) => s.to === "staff");

  test("a confirmed actor alerts once at the default threshold, then updates the same alert", async () => {
    vi.useFakeTimers();
    const t = harness({ notifyOwner: true });
    await wave(t, ["c1", "c2"], "a");
    expect(t.published).toHaveLength(0);
    await wave(t, ["c3"], "a");
    expect(t.published).toHaveLength(1);
    expect(t.published[0]?.payload).toMatchObject({
      actorId: "a",
      count: 3,
      certainty: "confirmed",
      responses: [],
      wouldRespond: ["removeRoles", "finalSanction", "requestSync"],
    });
    const post = staffPosts(t)[0]!.message as { content: string };
    expect(post.content).toContain(
      "Enforce mode would: remove the actor's roles; apply the configured final sanction (ban or quarantine); request a sync to restore the declared structure.",
    );
    await wave(t, ["c4"], "a");
    expect(alerts(t)).toHaveLength(1);
    expect(t.published.at(-1)?.payload).toMatchObject({ actorId: "a", count: 4 });
    expect(staffPosts(t)).toHaveLength(1);
    expect(t.edits.at(-1)?.message).toMatchObject({ content: expect.stringContaining("×4") });
    // The replayed settle and audit entry change nothing.
    await settle(t.ctx, "pair:channelDelete:c4");
    await audit(t.ctx, entry("e-c4", "c4", "a"));
    expect(t.published).toHaveLength(2);
    // Owner DM once for the incident.
    expect(t.sent.filter((s) => s.to === "dm:owner")).toHaveLength(1);
  });

  test("counts expire with the window: an isolated later deletion opens nothing", async () => {
    vi.useFakeTimers();
    const t = harness();
    await wave(t, ["c1", "c2"], "a");
    vi.setSystemTime(Date.now() + 61_000);
    await wave(t, ["c3"], "a");
    expect(t.published).toHaveLength(0);
    expect(alerts(t)).toHaveLength(0);
  });

  test("an unattributed burst gives one updated alert, one owner DM and no targeted proposal", async () => {
    vi.useFakeTimers();
    const t = harness({ notifyOwner: true });
    await wave(
      t,
      Array.from({ length: 10 }, (_, i) => "u" + i),
    );
    expect(alerts(t)).toHaveLength(1);
    expect(t.published).toHaveLength(10);
    expect(new Set(t.published.map((p) => JSON.stringify(p.payload))).size).toBe(10);
    expect(t.published.at(-1)?.payload).toMatchObject({
      actorType: "unknown",
      count: 10,
      wouldRespond: ["requestSync"],
    });
    expect(t.published.at(-1)?.payload).not.toHaveProperty("actorId");
    expect(staffPosts(t)).toHaveLength(1);
    const latest = t.edits.at(-1)!.message as { content: string };
    expect(latest.content).toContain("×10");
    expect(latest.content).toContain("Enforce mode would take no action against a person");
    expect(t.sent.filter((s) => s.to === "dm:owner")).toHaveLength(1);
    expect(t.moderation).toEqual([]);
    expect(t.roleChanges).toEqual([]);
  });

  test("French staff notice describes the would-be response", async () => {
    vi.useFakeTimers();
    const t = createTestContext({
      schema,
      locales: { en, fr },
      config: { staffChannel: "staff", locale: "fr", thresholds: { channelDelete: 1 } },
      channels: { staff: { name: "staff" } },
      server: { ownerId: "owner", protection: { ...protection, selfHeal: true } },
      members: [{ id: "owner" }, { id: "a" }],
    });
    await structure(t.ctx, "channelDelete", "x");
    await audit(
      t.ctx,
      entry("x1", "x", "a", { attribution: { kind: "bot", certainty: "confirmed" } }),
    );
    vi.setSystemTime(Date.now() + 30001);
    await settle(t.ctx, "pair:channelDelete:x");
    const post = t.sent.find((s) => s.to === "staff")!.message as { content: string };
    expect(post.content).toContain(
      "En mode enforce, Anti-nuke aurait : expulsé le bot; appliqué la sanction finale configurée (bannissement ou quarantaine).",
    );
  });
});
