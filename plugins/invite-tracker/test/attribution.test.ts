import { test, expect } from "vite-plus/test";
import { createTestContext } from "@cicord/sdk/testing";
import plugin from "../src/index.ts";
import en from "../locales/en.json" with { type: "json" };
import fr from "../locales/fr.json" with { type: "json" };
import schema from "../config.schema.json" with { type: "json" };
const caller = {
  caller: { bot: "bot", instance: "welcome", plugin: "welcome", source: "cicord", verified: true },
};
test("shared invite deltas survive concurrent handlers; new and ambiguous codes never identify a member", async () => {
  const invites = [
    { code: "a", uses: 0, inviter: { id: "20" } },
    { code: "b", uses: 0, inviter: { id: "21" } },
  ];
  const t = createTestContext({
    locales: { en, fr },
    schema,
    config: { minAccountDays: 0 },
    members: [1, 2, 3, 4, 5].map((n) => ({ id: String(n), joinedAt: new Date() })),
  });
  t.ctx.server.invites = async () =>
    invites.map((i) => ({ ...i, inviter: { ...t.member("1")!.user, id: i.inviter.id } }));
  await plugin.onStart!(t.ctx);
  invites[0]!.uses = 2;
  await Promise.all(["1", "2"].map((id) => plugin.events!.memberJoin!(t.ctx, t.member(id)!)));
  const q = (id: string) => plugin.queries!.inviterOf!.run(t.ctx, { userId: id }, caller);
  expect(await q("1")).toEqual({ inviterId: "20", code: "a" });
  expect(await q("2")).toEqual(await q("1"));
  invites.push({ code: "during-outage", uses: 1, inviter: { id: "22" } });
  await plugin.events!.memberJoin!(t.ctx, t.member("3")!);
  expect(await q("3")).toEqual({});
  invites[0]!.uses++;
  invites[1]!.uses++;
  await Promise.all(["4", "5"].map((id) => plugin.events!.memberJoin!(t.ctx, t.member(id)!)));
  expect(await q("4")).toEqual({});
  expect(await q("5")).toEqual({});
  await plugin.events!.memberLeave!(t.ctx, t.member("1")!.user);
  expect(await plugin.queries!.count!.run(t.ctx, { userId: "20" }, caller)).toEqual({
    valid: 1,
    fake: 1,
    left: 1,
  });
});
