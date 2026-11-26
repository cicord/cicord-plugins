import type { MessagePayload } from "@cicord/sdk";
import { callRoute, createTestContext, runCommand, submitModal } from "@cicord/sdk/testing";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import schema from "../config.schema.json" with { type: "json" };
import en from "../locales/en.json" with { type: "json" };
import fr from "../locales/fr.json" with { type: "json" };
import plugin from "../src/index.ts";
import { parseWhen } from "../src/messages.ts";
import { dueIn, nextRun, parseCron, parseSchedule } from "../src/schedule.ts";
import { offsetAt, parseLocal, toLocal, toUtc, ZONES } from "../src/tz.ts";

const grants = [
  "discord.messages.send",
  "discord.channels.read",
  "storage.kv",
  "scheduler",
  "portal.routes",
];

function setup(config: Record<string, unknown> = {}) {
  return createTestContext({
    locales: { en, fr },
    schema,
    config,
    grants,
    plugin: { name: "announcements" },
    roles: {
      events: { name: "Events", id: "100" },
      mod: { name: "Moderator", id: "200", permissions: ["ViewChannel", "ReadMessageHistory"] },
      other: { name: "Other", id: "300" },
    },
    channels: {
      announcements: { name: "announcements" },
      general: { name: "general" },
      voice: { name: "Voice", type: "voice" },
    },
    members: [{ id: "1", username: "mia", roles: ["mod"] }],
  });
}

type Harness = ReturnType<typeof setup>;
const MIN = 60_000;
const tick = (t: Harness) => plugin.schedules!.tick!.run(t.ctx);
const payload = (t: Harness, i = -1) => t.sent.at(i)!.message as MessagePayload;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-27T16:59:00Z")); // a Friday, 17:59 in Paris
});
afterEach(() => {
  vi.useRealTimers();
});

describe("time zones", () => {
  test("EU, US and southern DST rules", () => {
    const paris = (iso: string) => offsetAt("Europe/Paris", Date.parse(iso));
    expect(paris("2026-03-29T00:59:00Z")).toBe(60);
    expect(paris("2026-03-29T01:00:00Z")).toBe(120);
    expect(paris("2026-10-25T00:59:00Z")).toBe(120);
    expect(paris("2026-10-25T01:00:00Z")).toBe(60);
    const ny = (iso: string) => offsetAt("America/New_York", Date.parse(iso));
    expect(ny("2026-03-08T06:59:00Z")).toBe(-300);
    expect(ny("2026-03-08T07:00:00Z")).toBe(-240);
    expect(ny("2026-11-01T05:59:00Z")).toBe(-240);
    expect(ny("2026-11-01T06:00:00Z")).toBe(-300);
    expect(offsetAt("Australia/Sydney", Date.parse("2026-01-15T00:00:00Z"))).toBe(660);
    expect(offsetAt("Australia/Sydney", Date.parse("2026-07-15T00:00:00Z"))).toBe(600);
    expect(offsetAt("Pacific/Auckland", Date.parse("2026-12-15T00:00:00Z"))).toBe(780);
    expect(offsetAt("Asia/Kolkata", Date.parse("2026-12-15T00:00:00Z"))).toBe(330);
    // The schema lists exactly the zones the plugin knows.
    expect(schema.$defs.timeZone.enum).toEqual(Object.keys(ZONES));
  });

  test("local ↔ UTC, including DST gaps and repeats", () => {
    const local = parseLocal("2026-07-01 09:00")!;
    expect(new Date(toUtc("Europe/Paris", local) * MIN).toISOString()).toBe(
      "2026-07-01T07:00:00.000Z",
    );
    // 02:30 does not exist on 2026-03-29 in Paris: one hour later.
    const gap = parseLocal("2026-03-29 02:30")!;
    expect(new Date(toUtc("Europe/Paris", gap) * MIN).toISOString()).toBe(
      "2026-03-29T01:30:00.000Z",
    );
    // 02:30 happens twice on 2026-10-25: the first one.
    const twice = parseLocal("2026-10-25 02:30")!;
    expect(new Date(toUtc("Europe/Paris", twice) * MIN).toISOString()).toBe(
      "2026-10-25T00:30:00.000Z",
    );
    expect(toLocal("Europe/Paris", toUtc("Europe/Paris", local))).toBe(local);
    expect(parseLocal("2026-02-30 10:00")).toBeUndefined();
  });
});

describe("schedules", () => {
  test("cron fields, names, steps and day-of-month/day-of-week semantics", () => {
    const c = parseCron("*/15 9-17 * * mon-fri");
    expect([...c.minutes]).toEqual([0, 15, 30, 45]);
    expect([...c.dows]).toEqual([1, 2, 3, 4, 5]);
    expect([...parseCron("0 0 * * 7").dows]).toEqual([0]);
    expect(() => parseCron("0 25 * * *")).toThrow("out of range");
    expect(() => parseCron("0 0 * *")).toThrow("5 fields");
    // Both day fields restricted: either matches (standard cron).
    const s = parseSchedule({ cron: "0 12 1 * fri" });
    const fri = parseLocal("2026-11-27 12:00")!;
    const first = parseLocal("2026-12-01 12:00")!; // a Tuesday
    expect(dueIn(s, "UTC", fri, fri, undefined)).toBe(fri);
    expect(dueIn(s, "UTC", first, first, undefined)).toBe(first);
  });

  test("next runs: cron in a time zone, interval, one-off", () => {
    const now = Date.parse("2026-11-27T16:59:00Z") / MIN;
    const weekly = parseSchedule({ cron: "0 18 * * 5" });
    expect(new Date(nextRun(weekly, "Europe/Paris", now)! * MIN).toISOString()).toBe(
      "2026-11-27T17:00:00.000Z",
    );
    const every = parseSchedule({ every: "6h", start: "2026-11-27 06:00" });
    expect(new Date(nextRun(every, "UTC", now)! * MIN).toISOString()).toBe(
      "2026-11-27T18:00:00.000Z",
    );
    const once = parseSchedule({ at: "2026-11-27 17:00" });
    expect(nextRun(once, "UTC", now)).toBe(now + 1);
    expect(nextRun(once, "UTC", now + 1)).toBeUndefined();
  });

  test("invalid schedules are explained", () => {
    expect(() => parseSchedule({})).toThrow("exactly one of cron, every or at");
    expect(() => parseSchedule({ cron: "* * * * *", at: "2026-01-01 00:00" })).toThrow(
      "exactly one",
    );
    expect(() => parseSchedule({ every: "2m" })).toThrow("at least 5 minutes");
    expect(() => parseSchedule({ cron: "nope" })).toThrow('invalid cron "nope"');
  });
});

describe("configured announcements", () => {
  const weekly = {
    name: "game-night",
    channel: "announcements",
    cron: "0 18 * * 5",
    content: "Game night starts now! Ping <@&300> and @everyone",
    embed: { title: "🎲 Game night", color: "#ff0000" },
    mentions: { roles: ["events"], everyone: true },
  };

  test("the tick posts once when due, in the time zone, with safe mentions", async () => {
    const t = setup({ timeZone: "Europe/Paris", announcements: [weekly] });
    await tick(t); // 17:59 Paris: not yet
    expect(t.sent).toHaveLength(0);
    vi.setSystemTime(new Date("2026-11-27T17:00:20Z")); // 18:00 Paris
    await tick(t);
    expect(t.sent).toHaveLength(1);
    const p = payload(t);
    expect(p.content).toBe("<@&100>\nGame night starts now! Ping @Other and @​everyone");
    expect(p.allowedMentions).toEqual({ roles: true, users: false, everyone: false });
    expect(p.embeds).toEqual([{ title: "🎲 Game night", color: "#ff0000" }]);
    expect(t.logs.some((l) => l.message.includes("@everyone/@here left out"))).toBe(true);
    // Same minute again (a second tick, a restart): not posted twice.
    await tick(t);
    expect(t.sent).toHaveLength(1);
  });

  test("allowEveryone lets @everyone ping", async () => {
    const t = setup({ allowEveryone: true, timeZone: "Europe/Paris", announcements: [weekly] });
    vi.setSystemTime(new Date("2026-11-27T17:00:00Z"));
    await tick(t);
    expect(payload(t).content).toBe(
      "<@&100> @everyone\nGame night starts now! Ping @Other and @everyone",
    );
    expect(payload(t).allowedMentions).toEqual({ roles: true, users: false, everyone: true });
  });

  test("catch-up after downtime posts a missed run once; older ones are skipped", async () => {
    const t = setup({
      announcements: [{ name: "hourly", channel: "general", every: "1h", content: "tick" }],
    });
    vi.setSystemTime(new Date("2026-11-27T10:30:00Z"));
    await tick(t);
    vi.setSystemTime(new Date("2026-11-27T11:05:00Z")); // missed 11:00, within 10 minutes
    await tick(t);
    expect(t.sent).toHaveLength(1);
    vi.setSystemTime(new Date("2026-11-27T12:45:00Z")); // missed 12:00 by 45 minutes
    await tick(t);
    expect(t.sent).toHaveLength(1);
  });

  test("disabled and invalid announcements are listed, never posted", async () => {
    const t = setup({
      announcements: [
        { name: "off", channel: "general", every: "1h", content: "x", enabled: false },
        { name: "broken", channel: "general", cron: "61 * * * *", content: "x" },
        { name: "weekly", channel: "general", cron: "0 9 * * 1", content: "x" },
      ],
    });
    vi.setSystemTime(new Date("2026-11-27T11:00:00Z"));
    await tick(t);
    expect(t.sent).toHaveLength(0);
    const r = await runCommand(plugin, t, "announce-list", { user: "1" });
    const text = (r.replies[0] as MessagePayload).embeds![0]!.description!;
    expect(text).toContain("⏸️ **off** (<#channel-general>): every 1h, disabled");
    expect(text).toContain('⚠️ **broken** (<#channel-general>): invalid cron "61 * * * *"');
    expect(text).toContain(
      "🔁 **weekly** (<#channel-general>): cron `0 9 * * 1` (UTC), next <t:1796029200:F>",
    );
  });
});

describe("/announce", () => {
  async function compose(
    t: Harness,
    options: Record<string, unknown>,
    fields = { message: "Hello <@&300> @here", title: "News" },
  ) {
    const r = await runCommand(plugin, t, "announce", { user: "1", options });
    if (!r.modal) return { command: r, submit: undefined };
    const submit = await submitModal(plugin, t, r.modal.id, { user: "1", fields });
    return { command: r, submit };
  }
  const channel = (key: string) => ({
    id: `channel-${key}`,
    name: key,
    type: "text",
    mention: `<#channel-${key}>`,
  });

  test("now: the form posts right away, body in an embed, only the chosen mention pings", async () => {
    const t = setup();
    const { command, submit } = await compose(t, {
      channel: channel("announcements"),
      mention: { id: "100", name: "Events", mention: "<@&100>" },
    });
    expect(command.modal?.fields.map((f) => ("id" in f ? f.id : f.component.id))).toEqual([
      "title",
      "message",
    ]);
    expect(submit!.replies).toEqual([
      { content: "Posted in <#channel-announcements>.", ephemeral: true },
    ]);
    expect(payload(t)).toMatchObject({
      content: "<@&100>",
      embeds: [{ title: "News", description: "Hello <@&300> @here", color: "#5865f2" }],
      allowedMentions: { roles: true, users: false, everyone: false },
    });
  });

  test("later: schedules a task; list, the portal route, then cancel", async () => {
    const t = setup({ timeZone: "Europe/Paris" });
    const { submit } = await compose(t, { channel: channel("general"), when: "in 2h" });
    expect(t.sent).toHaveLength(0);
    expect(t.scheduled).toEqual([
      { id: "task-1", delayMs: 2 * 3_600_000, task: "post", payload: { id: 1 } },
    ]);
    expect((submit!.replies[0] as { content: string }).content).toContain(
      "Announcement #1 is scheduled for <t:",
    );

    const list = await runCommand(plugin, t, "announce-list", { user: "1" });
    expect((list.replies[0] as MessagePayload).embeds![0]!.description).toContain(
      "🗓️ **#1** <#channel-general>",
    );
    const route = await callRoute(plugin, t, "GET /scheduled", { viewer: "1" });
    expect(route.body).toMatchObject({
      timeZone: "Europe/Paris",
      scheduled: [{ id: 1, title: "News" }],
    });

    const cancel = await runCommand(plugin, t, "announce-cancel", {
      user: "1",
      options: { id: 1 },
    });
    expect(cancel.replies[0]).toContain("Announcement #1");
    expect(t.scheduled).toEqual([]);
    await plugin.tasks!.post!(t.ctx, { id: 1 }); // a task that fires anyway does nothing
    expect(t.sent).toHaveLength(0);
    const again = await runCommand(plugin, t, "announce-cancel", { user: "1", options: { id: 1 } });
    expect(again.replies[0]).toContain("No scheduled announcement #1");
  });

  test("the task posts the announcement", async () => {
    const t = setup();
    await compose(t, { channel: channel("general"), when: "18:30" });
    expect(t.scheduled[0]!.delayMs).toBe(91 * MIN); // 16:59 → 18:30 UTC
    await plugin.tasks!.post!(t.ctx, t.scheduled[0]!.payload);
    expect(t.sent[0]!.to).toBe("general");
    expect([...t.kv.keys()].some((k) => k.startsWith("ad:"))).toBe(false);
  });

  test("refusals: channel not allowed or not text, @everyone off, bad dates, limit", async () => {
    const t = setup({ channels: ["announcements"], maxScheduled: 1 });
    const replyOf = async (options: Record<string, unknown>) =>
      (await runCommand(plugin, t, "announce", { user: "1", options })).replies[0];
    expect(await replyOf({ channel: channel("general") })).toBe(
      "Announcements can be posted in <#channel-announcements>.",
    );
    const t2 = setup();
    expect(
      (
        await runCommand(plugin, t2, "announce", {
          user: "1",
          options: { channel: channel("voice") },
        })
      ).replies[0],
    ).toBe("<#channel-voice> is not a text channel.");
    expect(await replyOf({ channel: channel("announcements"), everyone: true })).toContain(
      "@everyone is turned off",
    );
    expect(
      await replyOf({ channel: channel("announcements"), when: "2020-01-01 10:00" }),
    ).toContain("is in the past");
    expect(await replyOf({ channel: channel("announcements"), when: "in 100 days" })).toContain(
      "up to 90 days",
    );
    expect(await replyOf({ channel: channel("announcements"), when: "someday" })).toContain(
      "I don't understand",
    );
    await compose(t, { channel: channel("announcements"), when: "1h" });
    expect(await replyOf({ channel: channel("announcements"), when: "2h" })).toContain(
      "1 announcements are already scheduled",
    );
    expect(plugin.commands!["announce"]!.permissions).toEqual(["ManageMessages"]);
  });

  test("an expired form says so", async () => {
    const t = setup();
    const r = await submitModal(plugin, t, "compose:99", { user: "1", fields: { message: "x" } });
    expect(r.replies[0]).toEqual({
      content: "This form expired: run /announce again.",
      ephemeral: true,
    });
  });
});

test("parseWhen", () => {
  const now = Date.parse("2026-11-27T16:59:00Z");
  const local = now / MIN;
  const utc = (l: number) => l * MIN;
  expect(parseWhen("", now, local, utc)).toBe(now);
  expect(parseWhen("in 1h30m", now, local, utc)).toBe(now + 90 * MIN);
  expect(parseWhen("3 days", now, local, utc)).toBe(now + 3 * 1440 * MIN);
  expect(parseWhen("16:00", now, local, utc)).toBe(Date.parse("2026-11-28T16:00:00Z"));
  expect(parseWhen("2026-12-24 18:00", now, local, utc)).toBe(Date.parse("2026-12-24T18:00:00Z"));
  expect(parseWhen("5 parsecs", now, local, utc)).toContain("Unknown unit");
});
