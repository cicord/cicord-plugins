import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  callRoute,
  createTestContext,
  runAutocomplete,
  runCommand,
  type TestHarness,
} from "@cicord/sdk/testing";
import type { InteropCall, PluginDefinition } from "@cicord/sdk";
import schema from "../config.schema.json" with { type: "json" };
import en from "../locales/en.json" with { type: "json" };

// Owner 10 reads everything; member 13 reads #staff through the crew role; member 11 and
// moderator 12 cannot read #staff.
function harness(config: Record<string, unknown> = {}) {
  return createTestContext({
    schema,
    config: { enabled: true, editableOnPortal: true, channels: ["help", "other"], ...config },
    locales: { en },
    features: ["files", "autoReplies"],
    files: {
      "tags/reset.md": "---\nname: Reset\naliases: [restart]\nkeywords: [locked out]\n---\nRestart it.",
      "tags/staff.md": "---\nname: Escalate\nchannel: staff\nkeywords: [escalate]\n---\nPage staff.",
    },
    roles: { crew: { name: "crew" } },
    members: [{ id: "10" }, { id: "11" }, { id: "12" }, { id: "13", roles: ["crew"] }],
    access: { moderators: { users: ["12"] } },
    server: { ownerId: "10", everyonePermissions: ["ViewChannel", "ReadMessageHistory"] },
    channels: {
      general: { name: "general" },
      help: { name: "help" },
      other: { name: "other" },
      staff: {
        name: "staff",
        overwrites: { "@everyone": { deny: ["ViewChannel"] }, crew: { allow: ["ViewChannel"] } },
      },
    },
  });
}
const caller = {
  plugin: "ai-assistant",
  bot: "bot",
  instance: "assistant",
  source: "cicord/ai-assistant",
  verified: true,
};
const as = (userId?: string): InteropCall =>
  userId ? { caller, onBehalfOf: { userId, access: "member" } } : { caller };
const portalTag = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  text: name + " answer.",
  aliases: [],
  keywords: [],
  ...extra,
});
/** A module instance that never ran onStart, like the provider realm of the runtime. */
async function freshPlugin() {
  vi.resetModules();
  return (await import("../src/index.ts")).default as PluginDefinition;
}
const names = (entries: { name: string }[]) => entries.map((e) => e.name).sort();
async function searchAs(plugin: PluginDefinition, h: TestHarness, q: string, userId?: string) {
  const out = (await plugin.queries!.search!.run(h.ctx, { query: q, limit: 10 }, as(userId))) as {
    entries: { name: string }[];
  };
  return names(out.entries);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("tags.search in a realm that never ran onStart", () => {
  it("rebuilds file and portal tags from files and KV", async () => {
    const h = harness();
    const writer = await freshPlugin();
    await writer.onStart!(h.ctx);
    const put = await callRoute(writer, h, "PUT /tags/Desk", { viewer: "10", body: portalTag("Desk") });
    expect(put.body).toEqual({ saved: true });
    const restricted = await callRoute(writer, h, "PUT /tags/Staffdesk", {
      viewer: "10",
      body: portalTag("Staffdesk", { channel: "staff" }),
    });
    expect(restricted.body).toEqual({ saved: true });

    const provider = await freshPlugin();
    expect(provider).not.toBe(writer);
    expect(await searchAs(provider, h, "", "10")).toEqual(["Desk", "Escalate", "Reset", "Staffdesk"]);
  });

  it("hides a private-channel tag from an onBehalfOf who cannot see the channel", async () => {
    const h = harness();
    await h.ctx.kv.set("portal:staffdesk", portalTag("Staffdesk", { channel: "staff" }));
    const provider = await freshPlugin();
    expect(await searchAs(provider, h, "", "11")).toEqual(["Reset"]);
    // Without a member identity only unrestricted tags are returned.
    expect(await searchAs(provider, h, "")).toEqual(["Reset"]);
    expect(await searchAs(provider, h, "staff", "13")).toEqual(["Staffdesk"]);
    // Losing access excludes the tag on the next call.
    await h.member("13")!.removeRole("crew");
    expect(await searchAs(provider, h, "staff", "13")).toEqual([]);
    expect(await searchAs(provider, h, "escalate", "13")).toEqual([]);
  });

  it("returns nothing when the instance is disabled", async () => {
    const provider = await freshPlugin();
    expect(await searchAs(provider, harness({ enabled: false }), "", "10")).toEqual([]);
  });
});

describe("commands", () => {
  it("shares a tag by alias, mentions only the chosen member and counts the use", async () => {
    const h = harness();
    const plugin = await freshPlugin();
    const r = await runCommand(plugin, h, "tag", {
      user: "11",
      channel: "general",
      options: { name: "restart", user: h.member("12")!.user },
    });
    expect(r.replies).toHaveLength(1);
    expect(r.replies[0]).toMatchObject({ content: "<@12> Restart it." });
    expect(r.replies[0]).toMatchObject({ allowedMentions: { users: ["12"], roles: false } });
    expect(await h.ctx.kv.get("used:reset")).toBe(1);
  });

  it("refuses a restricted tag to a member who cannot read its channel", async () => {
    const h = harness();
    const plugin = await freshPlugin();
    const r = await runCommand(plugin, h, "tag", {
      user: "11",
      channel: "general",
      options: { name: "Escalate" },
    });
    expect(r.replies).toEqual([{ content: en.missing, ephemeral: true }]);
    expect(h.kv.has("used:escalate")).toBe(false);
  });

  it("autocompletes only tags the member can read in this channel", async () => {
    const h = harness();
    const plugin = await freshPlugin();
    const auto = (user: string, channel: string) =>
      runAutocomplete(plugin, h, "tag", { user, channel, focused: "name", value: "" });
    expect(names(await auto("11", "general"))).toEqual(["Reset"]);
    // The owner reads #staff, but #general is wider than #staff: the copy would leak.
    expect(names(await auto("10", "general"))).toEqual(["Reset"]);
    expect(names(await auto("10", "staff"))).toEqual(["Escalate", "Reset"]);
  });
});

describe("keyword auto-replies", () => {
  it("debounces per channel", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-26T10:00:00Z"));
    const h = harness({ debounceSeconds: 60 });
    const plugin = await freshPlugin();
    const member = h.member("11")!;
    const say = (channel: string) =>
      plugin.events!.messageCreate!(h.ctx, {
        ...h.receive(h.channel(channel)!.id, member.user, "I am locked out"),
        member,
      });
    const replies = (channel: string) =>
      h.sent.filter((s) => s.to === h.channel(channel)!.id || s.to === channel).length;
    await say("help");
    await say("help");
    await say("other");
    await say("general"); // not a listed channel
    expect(replies("help")).toBe(1);
    expect(replies("other")).toBe(1);
    expect(replies("general")).toBe(0);
    vi.setSystemTime(new Date("2026-11-26T10:01:01Z"));
    await say("help");
    expect(replies("help")).toBe(2);
    expect(await h.ctx.kv.get("used:reset")).toBe(3);
  });

  it("does not auto-reply with a restricted tag in a wider channel", async () => {
    const h = harness();
    const plugin = await freshPlugin();
    const owner = h.member("10")!;
    await plugin.events!.messageCreate!(h.ctx, {
      ...h.receive(h.channel("help")!.id, owner.user, "escalate"),
      member: owner,
    });
    expect(h.sent).toHaveLength(0);
  });
});

describe("portal edits", () => {
  it("confines moderators to tags they can read and never widens a restricted tag", async () => {
    const h = harness();
    const plugin = await freshPlugin();
    const put = (viewer: string, name: string, body: unknown) =>
      callRoute(plugin, h, "PUT /tags/" + name, { viewer, body: body as never });
    // A moderator cannot create a tag for a channel they cannot read.
    expect((await put("12", "Secret", portalTag("Secret", { channel: "staff" }))).status).toBe(403);
    // The owner can; the moderator can then neither replace nor delete it.
    expect((await put("10", "Secret", portalTag("Secret", { channel: "staff" }))).body).toEqual({
      saved: true,
    });
    expect((await put("12", "Secret", portalTag("Secret"))).status).toBe(403);
    expect((await callRoute(plugin, h, "DELETE /tags/Secret", { viewer: "12" })).status).toBe(403);
    // Removing the channel restriction would publish a private answer.
    expect((await put("10", "Secret", portalTag("Secret"))).status).toBe(403);
    // File-backed names take precedence and cannot be shadowed.
    expect((await put("10", "Reset", portalTag("Reset"))).status).toBe(400);
    expect((await callRoute(plugin, h, "DELETE /tags/Secret", { viewer: "10" })).body).toEqual({
      deleted: true,
    });
    expect(h.kv.has("portal:secret")).toBe(false);
  });

  it("refuses an edit that raced another edit of the same tag (409)", async () => {
    const h = harness();
    const plugin = await freshPlugin();
    await callRoute(plugin, h, "PUT /tags/Desk", { viewer: "10", body: portalTag("Desk") });
    const winner = portalTag("Desk", { channel: "staff", text: "Staff only." });
    // Another moderator's write lands between this request's read and its commit.
    let raced = false;
    const kv = new Proxy(h.ctx.kv, {
      get(target, prop) {
        if (prop === "getEntry")
          return async (key: string) => {
            const entry = await target.getEntry(key);
            if (!raced && key === "portal:desk") {
              raced = true;
              await target.set(key, winner);
            }
            return entry;
          };
        const value = Reflect.get(target, prop) as unknown;
        return typeof value === "function" ? (value as () => unknown).bind(target) : value;
      },
    });
    const racing = { ...h, ctx: new Proxy(h.ctx, { get: (t, p) => (p === "kv" ? kv : Reflect.get(t, p)) }) };
    const put = await callRoute(plugin, racing as TestHarness, "PUT /tags/Desk", {
      viewer: "10",
      body: portalTag("Desk", { text: "Public again." }),
    });
    expect(put.status).toBe(409);
    expect(h.kv.get("portal:desk")).toEqual(winner);
    raced = false;
    const del = await callRoute(plugin, racing as TestHarness, "DELETE /tags/Desk", { viewer: "10" });
    expect(del.status).toBe(409);
    expect(h.kv.get("portal:desk")).toEqual(winner);
  });

  it("marks file-backed tags as not editable and lists only readable tags", async () => {
    const h = harness();
    const plugin = await freshPlugin();
    await callRoute(plugin, h, "PUT /tags/Desk", { viewer: "10", body: portalTag("Desk") });
    const mod = (await callRoute(plugin, h, "GET /tags", { viewer: "12" })).body as {
      entries: { name: string; editable: boolean }[];
    };
    expect(mod.entries.map((e) => [e.name, e.editable])).toEqual([
      ["Desk", true],
      ["Reset", false],
    ]);
  });
});
