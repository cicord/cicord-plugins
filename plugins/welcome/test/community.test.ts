import type { PluginDefinition } from "@cicord/sdk";
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
test("verified trigger waits, replay greets once, and privacy isolates two members", async () => {
  const t = setup({
    channel: "general",
    trigger: "verified",
    locale: "fr",
    showInviter: true,
    dmOnboarding: false,
  });
  const meta = {
    id: "event",
    topic: "verification.passed",
    version: 1,
    at: new Date().toISOString(),
    publisher: { plugin: "verification", instance: "check", bot: "b" },
  };
  await plugin.events!.memberJoin!(t.ctx, t.member("1")!);
  expect(t.sent).toHaveLength(0);
  const subscriptions: NonNullable<PluginDefinition["subscriptions"]> = plugin.subscriptions!;
  const passed = (userId: string) =>
    subscriptions["verification.passed"]!(t.ctx, { userId, method: "code" }, meta);
  await passed("1");
  await passed("1");
  expect(t.sent).toHaveLength(1);
  Object.assign(t.ctx, { plugins: { has: () => true, query: async () => ({ inviterId: "1" }) } });
  await passed("2");
  expect(t.sent[1]!.message).toMatchObject({
    content: expect.stringContaining("Invitation de <@1>"),
  });
  await plugin.privacy!.erase(t.ctx, "1");
  expect(await plugin.privacy!.export(t.ctx, "1")).toEqual({});
  expect(await plugin.privacy!.export(t.ctx, "2")).toMatchObject({ number: 2 });
});
test("missing verification grant never substitutes a join; onboarding checks the flag transition", async () => {
  const t = setup({ trigger: "verified", channel: "general" }, ["verified"]);
  await plugin.events!.memberJoin!(t.ctx, t.member("1")!);
  expect(t.sent).toHaveLength(0);
  const v = setup({ trigger: "onboarded", channel: "general", dmOnboarding: false });
  const m = v.member("1")!;
  const completed = Object.assign(Object.create(m), { flags: ["completedOnboarding"] });
  await plugin.events!.memberUpdate!(v.ctx, completed, completed);
  expect(v.sent).toHaveLength(0);
  await plugin.events!.memberUpdate!(v.ctx, completed, undefined);
  expect(v.sent).toHaveLength(1);
});

test("optional render or provider failures still deliver the configured greeting", async () => {
  const t = setup({
    channel: "general",
    trigger: "join",
    card: true,
    showInviter: true,
    dmOnboarding: false,
  });
  const report = vi.fn();
  Object.assign(t.ctx, {
    features: { enabled: () => true, report },
    render: {
      image: async () => {
        throw Error("deadline");
      },
    },
    plugins: {
      has: () => true,
      query: async () => {
        throw Error("timeout");
      },
    },
  });
  await plugin.events!.memberJoin!(t.ctx, t.member("1")!);
  expect(t.sent).toHaveLength(1);
  expect(t.sent[0]!.message).toMatchObject({ content: expect.stringContaining("Welcome") });
  expect(report).toHaveBeenCalledWith("cards", false, "Welcome card rendering failed");
  expect(report).toHaveBeenCalledWith("inviter", false, "Inviter query unavailable");
});
