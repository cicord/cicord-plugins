import type { Context, Message } from "@cicord/sdk";
import { createTestContext, type TestContextOptions } from "@cicord/sdk/testing";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import schema from "../config.schema.json" with { type: "json" };
import en from "../locales/en.json" with { type: "json" };
import fr from "../locales/fr.json" with { type: "json" };
import plugin from "../src/index.ts";
import { refreshFeeds } from "../src/rules.ts";

type Options = Partial<TestContextOptions> & { features?: string[] };
function setup(config: Record<string, unknown> = {}, options: Options = {}) {
  const t = createTestContext({
    schema,
    locales: { en, fr },
    config: { newAccounts: { restrict: [] }, ...config },
    server: { ownerId: "staff" },
    channels: { a: { name: "A" }, b: { name: "B" }, c: { name: "C" } },
    members: [
      { id: "user", joinedAt: new Date(0) },
      { id: "other", joinedAt: new Date(0) },
      { id: "third", joinedAt: new Date(0) },
      { id: "feedbot", bot: true, joinedAt: new Date(0) },
      { id: "staff" },
    ],
    ...options,
  });
  const status = vi.spyOn(t.ctx.status, "set");
  return { ...t, status };
}
type Harness = ReturnType<typeof setup>;

/** Messages the duplicate rule can fetch again by channel and ID. */
function world(t: Harness) {
  const messages = new Map<string, Message>();
  const channels = new Map<string, Message["channel"]>();
  let seq = 0;
  const channelFor = (key: string) => {
    const base = t.channel(key)!;
    if (!channels.has(base.id))
      channels.set(base.id, { ...base, message: async (id: string) => messages.get(id) });
    return channels.get(base.id)!;
  };
  const ctx: Context = {
    ...t.ctx,
    server: {
      ...t.ctx.server,
      channel: (ref) =>
        channels.get(typeof ref === "string" ? t.channel(ref)!.id : ref.id) ??
        t.ctx.server.channel(ref),
    },
  };
  async function post(user: string, key: string, content: string, extra: Partial<Message> = {}) {
    const m = t.member(user)!;
    const channel = channelFor(key);
    const msg: Message = {
      ...(await t.channel(key)!.send("fixture")),
      id: "m" + ++seq,
      author: m.user,
      member: m,
      channel,
      content,
      attachments: [],
      ...extra,
    };
    msg.delete = async () => {
      t.deletedMessages.push({ id: msg.id });
    };
    messages.set(msg.id, msg);
    await plugin.events!.messageCreate!(ctx, msg);
    return msg;
  }
  return { ctx, post };
}
const rules = (t: Harness) =>
  t.published.filter((e) => e.topic === "violation").map((e) => (e.payload as { rule: string }).rule);

afterEach(() => vi.useRealTimers());

describe("invites (SPA-5)", () => {
  test("without the invite grant every invite is blocked and the status says why", async () => {
    const t = setup();
    const { post } = world(t);
    await post("user", "a", "join us https://discord.gg/own");
    expect(rules(t)).toEqual(["links"]);
    expect(t.status).toHaveBeenCalledWith("invites", expect.stringContaining("discord.invites.read"));
  });
  test("with the grant this server's invites pass and others are blocked", async () => {
    const t = setup(
      {},
      {
        features: ["invites"],
        invites: [{ code: "own" } as never],
      },
    );
    const { post } = world(t);
    await post("user", "a", "https://discord.gg/own");
    expect(t.status).toHaveBeenCalledWith("invites", null);
    expect(rules(t)).toEqual([]);
    await post("other", "a", "https://discord.com/invite/elsewhere");
    expect(rules(t)).toEqual(["links"]);
  });
  test("a failed invite lookup fails closed", async () => {
    const t = setup({}, { features: ["invites"] });
    const { ctx, post } = world(t);
    vi.spyOn(ctx.server, "invites").mockRejectedValue(new Error("Missing Permissions"));
    await post("user", "a", "https://discord.gg/own");
    expect(rules(t)).toEqual(["links"]);
    expect(t.status).toHaveBeenCalledWith("invites", expect.stringContaining("ManageServer"));
  });
  test("allowOwnInvites: false blocks own invites too; blockInvites: false lets them through", async () => {
    const t = setup(
      { links: { allowOwnInvites: false } },
      { features: ["invites"], invites: [{ code: "own" } as never] },
    );
    await world(t).post("user", "a", "https://discord.gg/own");
    expect(rules(t)).toEqual(["links"]);
    const open = setup({ links: { blockInvites: false } });
    await world(open).post("user", "a", "https://discord.gg/own");
    expect(rules(open)).toEqual([]);
  });
});

describe("domains", () => {
  test("allowlist mode permits listed suffixes only", async () => {
    const t = setup({ links: { mode: "allowlist", domains: ["example.org"] } });
    const { post } = world(t);
    await post("user", "a", "see https://docs.example.org/page");
    expect(rules(t)).toEqual([]);
    await post("other", "a", "see https://example.org.evil.test/page");
    expect(rules(t)).toEqual(["links"]);
  });
  test("shorteners are blocked only when configured", async () => {
    const off = setup();
    await world(off).post("user", "a", "https://bit.ly/x");
    expect(rules(off)).toEqual([]);
    const on = setup({ links: { blockShorteners: true } });
    await world(on).post("user", "a", "https://bit.ly/x");
    expect(rules(on)).toEqual(["links"]);
  });
  test("feeds add their domains; a failing feed throws and keeps the previous list", async () => {
    let body = "scam.example\nnot a domain\n";
    let status = 200;
    const t = setup(
      { links: { feeds: [{ url: "https://feeds.example/list", format: "lines" }] } },
      { features: ["feeds"], fetch: () => ({ status, body }) },
    );
    await refreshFeeds(t.ctx);
    expect(t.kv.get("feed")).toEqual(["scam.example"]);
    await world(t).post("user", "a", "https://login.scam.example/");
    expect(rules(t)).toEqual(["links"]);
    status = 503;
    body = "";
    await expect(refreshFeeds(t.ctx)).rejects.toThrow("unavailable");
    expect(t.kv.get("feed")).toEqual(["scam.example"]);
    const ungranted = setup({ links: { feeds: [{ url: "https://feeds.example/list", format: "lines" }] } });
    await refreshFeeds(ungranted.ctx);
    expect(ungranted.requests).toEqual([]);
  });
});

describe("mentions", () => {
  test("a single message over perMessage triggers; small messages add up per window", async () => {
    const t = setup({ mentions: { perMessage: 3, perWindow: 4, seconds: 30 } });
    const { post } = world(t);
    await post("user", "a", "<@1> <@2>");
    expect(rules(t)).toEqual([]);
    await post("other", "a", "<@1> <@2> <@3>");
    expect(rules(t)).toEqual(["mentions"]);
    await post("user", "b", "<@3> <@4>");
    expect(rules(t)).toEqual(["mentions", "mentions"]);
  });
});

describe("new accounts", () => {
  test("a recent member's link is removed by default; established and verified members pass", async () => {
    const t = setup(
      { mode: "enforce", newAccounts: { restrict: ["links", "attachments"] } },
      { features: ["removeMessages"] },
    );
    t.addMember({ id: "newcomer", joinedAt: new Date() });
    const { post } = world(t);
    const msg = await post("newcomer", "a", "my site https://fine.example");
    expect(rules(t)).toEqual(["newAccounts"]);
    // Default action is delete: the restriction removes the content, no warning case.
    expect(t.deletedMessages.map((x) => x.id)).toEqual([msg.id]);
    expect(t.moderation).toEqual([]);
    await post("user", "a", "my site https://fine.example");
    expect(rules(t)).toEqual(["newAccounts"]);
  });
  test("a verified newcomer is exempt through verification.status", async () => {
    const queries: string[] = [];
    const t = setup(
      { newAccounts: { restrict: ["links"] } },
      {
        features: ["verification"],
        plugins: {
          has: (name) => name === "verification",
          hasFeature: () => false,
          query: async (plugin, method) => {
            queries.push(plugin + "." + method);
            return { verified: true };
          },
          call: async () => {
            throw new Error("unexpected");
          },
        } as Context["plugins"],
      },
    );
    t.addMember({ id: "newcomer", joinedAt: new Date() });
    await world(t).post("newcomer", "a", "https://fine.example");
    expect(queries).toEqual(["verification.status"]);
    expect(rules(t)).toEqual([]);
  });
});

describe("duplicates (MOD-06)", () => {
  test("short chatter and single-channel repeats never count by default", async () => {
    const t = setup({ mode: "enforce" }, { features: ["removeMessages", "directQuarantine"] });
    const { post } = world(t);
    for (const key of ["a", "b", "a", "b", "c"]) await post("user", key, "gg");
    for (let i = 0; i < 5; i++) await post("other", "a", "the same long sentence about the event");
    expect(rules(t)).toEqual([]);
    expect(t.deletedMessages).toEqual([]);
  });
  test("four long copies across two channels are removed without a sanction by default", async () => {
    const t = setup({ mode: "enforce" }, { features: ["removeMessages", "directQuarantine"] });
    const { post } = world(t);
    for (const key of ["a", "b", "a"]) await post("user", key, "free nitro for everyone here today");
    expect(rules(t)).toEqual([]);
    await post("user", "b", "free nitro for everyone here today");
    expect(rules(t)).toEqual(["duplicates"]);
    expect(t.deletedMessages).toHaveLength(4);
    expect(t.roleChanges).toEqual([]);
  });
  test("a short repeated link still counts", async () => {
    const t = setup();
    const { post } = world(t);
    for (const key of ["a", "b", "c", "a"]) await post("user", key, "x.test/a");
    expect(rules(t)).toContain("duplicates");
  });
});

describe("bots (MOD-07)", () => {
  test("bot authors are never inspected, deleted or sanctioned, listed or not", async () => {
    const t = setup(
      {
        mode: "enforce",
        links: { domains: ["blocked.example"], action: { type: "ban" } },
        duplicates: { count: 2, minChannels: 1 },
      },
      { features: ["removeMessages", "directSanctions"] },
    );
    const { post } = world(t);
    for (const key of ["a", "b", "c"]) await post("feedbot", key, "https://blocked.example/news");
    expect(t.published).toEqual([]);
    expect(t.deletedMessages).toEqual([]);
    expect(t.moderation).toEqual([]);
    await plugin.events!.memberJoin!(t.ctx, t.member("feedbot")!);
    expect(t.kv.get("join:feedbot")).toBeUndefined();
  });
});

describe("automatic sanction limit (MOD-06)", () => {
  test("above the per-window limit findings wait for staff review", async () => {
    vi.useFakeTimers();
    const t = setup(
      {
        mode: "enforce",
        links: { domains: ["blocked.example"], action: { type: "timeout", minutes: 5 } },
        sanctionLimit: { count: 2, seconds: 60 },
      },
      { features: ["removeMessages", "directSanctions"] },
    );
    const { post } = world(t);
    for (const user of ["user", "other", "third"]) await post(user, "a", "https://blocked.example");
    expect(t.moderation.map((m) => m.member)).toEqual(["user", "other"]);
    expect(t.kv.get("violations:third")).toMatchObject([{ status: "needs_review" }]);
    expect(t.status).toHaveBeenCalledWith("sanctionLimit", expect.stringContaining("2"));
    vi.advanceTimersByTime(61_000);
    await post("third", "b", "https://blocked.example");
    expect(t.moderation.map((m) => m.member)).toEqual(["user", "other", "third"]);
    expect(t.status).toHaveBeenLastCalledWith("sanctionLimit", null);
  });
});

describe("AutoMod escalation", () => {
  const block = (userId: string, n: number) => ({
    userId,
    channelId: "a",
    action: "blockMessage",
    rule: "r" + n,
  });
  test("the configured number of blocks records one violation", async () => {
    const t = setup({ automod: { count: 3, seconds: 600 } });
    t.channel("a");
    const channelId = t.channel("a")!.id;
    for (let n = 0; n < 2; n++)
      await plugin.events!.automodAction!(t.ctx, { ...block("user", n), channelId } as never);
    expect(rules(t)).toEqual([]);
    await plugin.events!.automodAction!(t.ctx, { ...block("user", 2), channelId } as never);
    expect(rules(t)).toEqual(["automod"]);
    expect(t.kv.get("automod:user")).toBeUndefined();
  });
  test("alerts and timeouts are not blocks, and staff are exempt", async () => {
    const t = setup({ automod: { count: 1 } });
    const channelId = t.channel("a")!.id;
    await plugin.events!.automodAction!(t.ctx, {
      ...block("user", 0),
      channelId,
      action: "sendAlertMessage",
    } as never);
    await plugin.events!.automodAction!(t.ctx, { ...block("staff", 1), channelId } as never);
    expect(rules(t)).toEqual([]);
  });
});
