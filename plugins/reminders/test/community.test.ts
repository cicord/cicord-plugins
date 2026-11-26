import { expect, test, vi, afterEach, beforeEach } from "vite-plus/test";
import { createTestContext, runCommand, runComponent } from "@cicord/sdk/testing";
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
import { parseDate } from "../src/time.ts";
test("tomorrow/demain, spring gap and first repeated autumn hour", () => {
  const now = Date.parse("2026-03-28T08:00:00Z");
  expect(parseDate("tomorrow 9am", "Europe/Paris", now)).toBe(
    parseDate("demain 9h", "Europe/Paris", now),
  );
  expect(parseDate("demain 9h", "Europe/Paris", now)).toBe(Date.parse("2026-03-29T07:00:00Z"));
  expect(parseDate("2026-03-29 02:30", "Europe/Paris", now)).toBe(
    Date.parse("2026-03-29T01:30:00Z"),
  );
  expect(parseDate("2026-10-25 02:15", "Europe/Paris", now)).toBe(
    Date.parse("2026-10-25T00:15:00Z"),
  );
  expect(parseDate("2026-02-30 09:00", "UTC", now)).toBeUndefined();
});
test("late delivery, owner-only cancellation, replay and single-use snooze", async () => {
  const t = setup({ locale: "fr", maxActive: 1 });
  const create = (user: string) =>
    runCommand(plugin, t, "remind create", {
      user,
      options: { when: "2h", message: "rendez-vous" },
    });
  await Promise.all([create("1"), create("1")]);
  const ids = await t.ctx.kv.get<string[]>("active:1");
  expect(ids).toHaveLength(1);
  const r = await runCommand(plugin, t, "remind cancel", { user: "2", options: { id: ids![0] } });
  expect(r.replies[0]).toBe(fr.missing);
  const pending = t.scheduled.find((x) => x.task === "deliver")!;
  vi.setSystemTime(Date.now() + 125 * 60000);
  await plugin.tasks!.deliver!(t.ctx, pending.payload);
  await plugin.tasks!.deliver!(t.ctx, pending.payload);
  expect(t.sent).toHaveLength(1);
  const msg = t.sent[0]!.message as {
    content: string;
    components: { components: { id: string }[] }[];
  };
  expect(msg.content).toContain("5 min de retard");
  const button = msg.components[0]!.components[0]!.id;
  await runComponent(plugin, t, button, { user: "2" });
  expect(await t.ctx.kv.get("active:2")).toBeUndefined();
  await runComponent(plugin, t, button, { user: "1" });
  await runComponent(plugin, t, button, { user: "1" });
  expect(await t.ctx.kv.get("active:1")).toHaveLength(1);
  await runCommand(plugin, t, "timezone set", { user: "1", options: { zone: "Europe/Paris" } });
  await create("2");
  await plugin.privacy!.erase(t.ctx, "1");
  expect(await plugin.privacy!.export(t.ctx, "1")).toEqual({
    reminders: [],
    snoozes: [],
    timeZone: null,
  });
  expect(await t.ctx.kv.get("active:2")).toHaveLength(1);
});
test("repeat obeys configured minimum and advances past missed periods", async () => {
  const t = setup({ minRepeatMinutes: 60 });
  const create = (repeat: string) =>
    runCommand(plugin, t, "remind create", {
      user: "1",
      options: { when: "1h", message: "test", repeat },
    });
  await create("10m");
  expect(t.scheduled).toHaveLength(0);
  await create("2h");
  const first = t.scheduled[0]!;
  vi.setSystemTime(Date.now() + 8 * 3600000);
  await plugin.tasks!.deliver!(t.ctx, first.payload);
  await plugin.tasks!.deliver!(t.ctx, first.payload);
  expect(t.sent).toHaveLength(1);
  expect(t.scheduled.at(-1)!.delayMs).toBe(3600000);
});
import { nextDue } from "../src/time.ts";
test("daily and weekly repeats keep their local time across DST; shorter ones are elapsed", () => {
  const paris = (iso: string) => Date.parse(iso);
  const daily = { due: paris("2026-03-28T08:00:00Z"), repeat: 86400000, zone: "Europe/Paris" };
  // 09:00 CET, then 09:00 CEST the next day (07:00 UTC), not 10:00.
  expect(nextDue(daily, daily.due)).toBe(paris("2026-03-29T07:00:00Z"));
  const autumn = { due: paris("2026-10-24T07:00:00Z"), repeat: 86400000, zone: "Europe/Paris" };
  expect(nextDue(autumn, autumn.due)).toBe(paris("2026-10-25T08:00:00Z"));
  // A missed week resumes at the local time; the anchor survives a skipped clock time.
  const weekly = {
    due: paris("2026-03-06T14:00:00Z"), // Friday 09:00 EST
    repeat: 7 * 86400000,
    zone: "America/New_York",
  };
  expect(nextDue(weekly, weekly.due)).toBe(paris("2026-03-13T13:00:00Z")); // 09:00 EDT
  expect(nextDue(weekly, paris("2026-03-14T00:00:00Z"))).toBe(paris("2026-03-20T13:00:00Z"));
  const gap = {
    due: paris("2026-03-29T01:30:00Z"), // 02:30 does not exist; 03:30 CEST
    anchor: Date.parse("2026-03-29T02:30:00Z"), // local wall clock 02:30
    repeat: 86400000,
    zone: "Europe/Paris",
  };
  expect(nextDue(gap, gap.due)).toBe(paris("2026-03-30T00:30:00Z"));
  // 2h is elapsed time, and a record without a zone (earlier versions) keeps elapsed days.
  const hours = { due: daily.due, repeat: 7200000, zone: "Europe/Paris" };
  expect(nextDue(hours, daily.due + 5 * 3600000)).toBe(daily.due + 6 * 3600000);
  expect(nextDue({ due: daily.due, repeat: 86400000 }, daily.due)).toBe(daily.due + 86400000);
});
test("a daily channel reminder follows the member's zone across the spring change", async () => {
  vi.setSystemTime(Date.parse("2026-03-27T12:00:00Z"));
  const t = permissionSetup();
  await runCommand(plugin, t, "timezone set", { user: "2", options: { zone: "Europe/Paris" } });
  await runCommand(plugin, t, "remind create", {
    user: "2",
    channel: "general",
    options: { when: "2026-03-28 09:00", message: "standup", where: "channel", repeat: "1d" },
  });
  for (const at of ["2026-03-28T08:00:00Z", "2026-03-29T07:00:00Z", "2026-03-30T07:00:00Z"]) {
    const task = t.scheduled.at(-1)!;
    expect(Date.now() + task.delayMs).toBe(Date.parse(at));
    vi.setSystemTime(Date.parse(at));
    await plugin.tasks!.deliver!(t.ctx, task.payload);
  }
  expect(t.sent.map((s) => s.to)).toEqual(["general", "general", "general"]);
});

function permissionSetup() {
  const t = createTestContext({
    schema,
    locales: { en, fr },
    config: {},
    server: {
      ownerId: "1",
      everyonePermissions: ["ViewChannel", "ReadMessageHistory", "SendMessages"],
    },
    roles: { writers: { name: "Writers" } },
    channels: {
      general: { name: "General" },
      rules: {
        name: "Rules",
        overwrites: {
          "@everyone": { deny: ["SendMessages"] },
          writers: { allow: ["SendMessages"] },
        },
      },
    },
    members: [{ id: "1" }, { id: "2", roles: ["writers"] }, { id: "3" }],
  });
  const notices = new Map<string, string | null>();
  Object.assign(t.ctx, { status: { set: (k: string, v: string | null) => notices.set(k, v) } });
  return Object.assign(t, { notices });
}
test("a channel reminder needs the member's own send permission, at creation and delivery", async () => {
  const t = permissionSetup();
  const create = (user: string) =>
    runCommand(plugin, t, "remind create", {
      user,
      channel: "rules",
      options: { when: "1h", message: "posted as the bot", where: "channel" },
    });
  const denied = await create("3");
  expect(denied.replies[0]).toMatchObject({ content: en.channelDenied });
  expect(t.scheduled).toHaveLength(0);
  await create("2");
  const task = t.scheduled[0]!;
  // The member loses the role that let them write there before the reminder is due.
  await t.member("2")!.removeRole("writers");
  vi.setSystemTime(Date.now() + 3600000);
  await plugin.tasks!.deliver!(t.ctx, task.payload);
  expect(t.sent).toHaveLength(1);
  expect(t.sent[0]!.to).not.toBe("rules");
  expect((t.sent[0]!.message as { content: string }).content).toContain("Sent privately");
});
test("a refused DM skips the occurrence with a status line and keeps the repeat", async () => {
  const t = permissionSetup();
  await runCommand(plugin, t, "remind create", {
    user: "2",
    options: { when: "1h", message: "water the plants", repeat: "1d" },
  });
  const member = t.member("2")!;
  let refuse = true;
  const lookup = t.ctx.server.member.bind(t.ctx.server);
  Object.assign(t.ctx.server, {
    member: async (id: string) =>
      id === "2"
        ? Object.assign(Object.create(member), {
            send: async (m: Parameters<typeof member.send>[0]) => {
              if (refuse)
                throw new Error(
                  "discord create DM: discord: missing permissions (HTTP 403 50007: Cannot send messages to this user)",
                );
              return member.send(m);
            },
          })
        : lookup(id),
  });
  vi.setSystemTime(Date.now() + 3600000);
  await plugin.tasks!.deliver!(t.ctx, t.scheduled.at(-1)!.payload);
  expect(t.sent).toHaveLength(0);
  expect(t.notices.get("dm")).toContain("missing permissions");
  expect(t.scheduled.at(-1)!.delayMs).toBe(86400000);
  refuse = false;
  vi.setSystemTime(Date.now() + 86400000);
  await plugin.tasks!.deliver!(t.ctx, t.scheduled.at(-1)!.payload);
  expect(t.sent).toHaveLength(1);
  expect(t.notices.get("dm")).toBeNull();
});
