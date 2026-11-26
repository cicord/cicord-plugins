import type { AuditLogEntry } from "@cicord/sdk";
import { createTestContext, callRoute } from "@cicord/sdk/testing";
import { afterEach, expect, test, vi } from "vite-plus/test";
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
