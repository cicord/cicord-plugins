import type { Embed, Json, MessagePayload, TextChannel } from "@cicord/sdk";
import {
  createTestContext,
  runAutocomplete,
  runCommand,
  type TestFetchResponse,
} from "@cicord/sdk/testing";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import schema from "../config.schema.json" with { type: "json" };
import { checkFeeds, feedKey, type FeedState } from "../src/feeds.ts";
import { rateLimit } from "../src/github.ts";
import plugin from "../src/index.ts";
import { DESCRIPTION_LIMIT, trimNotes } from "../src/render.ts";

const grants = [
  "discord.messages.send",
  "discord.channels.read",
  "storage.kv",
  "scheduler",
  "http.fetch",
];
const MIN = 60_000;
const T0 = Date.parse("2026-11-24T12:00:00Z");

interface RawRelease {
  id: number;
  tag_name: string;
  name: string | null;
  html_url: string;
  body: string | null;
  draft: boolean;
  prerelease: boolean;
  published_at: string | null;
  author: { login: string; html_url: string; avatar_url: string } | null;
}

function rel(
  id: number,
  tag: string,
  minutesAgo: number,
  extra: Partial<RawRelease> = {},
): RawRelease {
  return {
    id,
    tag_name: tag,
    name: tag,
    html_url: `https://github.com/cicord/cicord/releases/tag/${tag}`,
    body: `Notes of ${tag}`,
    draft: false,
    prerelease: false,
    published_at: new Date(Date.now() - minutesAgo * MIN).toISOString(),
    author: {
      login: "octocat",
      html_url: "https://github.com/octocat",
      avatar_url: "https://avatars.githubusercontent.com/u/1",
    },
    ...extra,
  };
}

/** A fake api.github.com: the releases of each repo (newest first, like GitHub), ETags, errors. */
class FakeGitHub {
  repos = new Map<string, RawRelease[]>();
  /** Answer instead of the releases (per repo), e.g. a 404 or a 429. */
  override = new Map<string, TestFetchResponse | Error>();
  version = 1;
  set(repo: string, releases: RawRelease[]): void {
    this.repos.set(
      repo,
      releases.toSorted((a, b) => b.id - a.id),
    );
    this.version++;
  }
  add(repo: string, ...releases: RawRelease[]): void {
    this.set(repo, [...(this.repos.get(repo) ?? []), ...releases]);
  }
  fetch = (url: string, init?: { headers?: Record<string, string> }): TestFetchResponse => {
    const m = /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/releases\?per_page=10$/.exec(
      url,
    );
    if (!m) throw new Error(`unexpected URL ${url}`);
    const repo = m[1]!;
    const o = this.override.get(repo);
    if (o instanceof Error) throw o;
    if (o) return o;
    const releases = this.repos.get(repo);
    if (!releases) return { status: 404, body: { message: "Not Found" } };
    const etag = `W/"${repo}-${this.version}"`;
    if (init?.headers?.["If-None-Match"] === etag) return { status: 304, headers: { etag } };
    return {
      status: 200,
      headers: { etag, "x-ratelimit-remaining": "59" },
      body: releases.slice(0, 10) as unknown as Json,
    };
  };
}

function setup(config: Record<string, unknown> = {}, gh = new FakeGitHub()) {
  const t = createTestContext({
    schema,
    config: { feeds: [{ repo: "cicord/cicord", channel: "changelog" }], ...config },
    grants,
    plugin: { name: "github-releases", version: "0.1.0" },
    fetch: gh.fetch,
    roles: { updates: { name: "Updates", id: "500" } },
    channels: { changelog: { name: "changelog" }, beta: { name: "beta" } },
    members: [{ id: "1", username: "mia" }],
  });
  return { t, gh };
}

type Harness = ReturnType<typeof setup>["t"];
const tick = (t: Harness) => plugin.schedules!.poll!.run(t.ctx);
const later = (minutes: number) => vi.setSystemTime(Date.now() + minutes * MIN);
const embedOf = (t: Harness, i = -1): Embed =>
  (t.sent.at(i)!.message as MessagePayload).embeds![0]!;
const titles = (t: Harness) => t.sent.map((s) => (s.message as MessagePayload).embeds![0]!.title);
const state = (t: Harness, repo = "cicord/cicord", channel = "changelog") =>
  t.kv.get(feedKey({ repo, channel, includePrereleases: false })) as unknown as FeedState;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("polling", () => {
  test("first check records the existing releases without posting (announceExisting off)", async () => {
    const { t, gh } = setup();
    gh.set("cicord/cicord", [rel(1, "v0.1.0", 300), rel(2, "v0.2.0", 200)]);
    await tick(t);
    expect(t.sent).toEqual([]);
    expect(state(t)).toMatchObject({ seeded: true, cursor: { id: 2 }, etag: expect.any(String) });
    expect(state(t).latest?.tag).toBe("v0.2.0");
    expect(t.logs.some((l) => l.message.includes("existing releases recorded"))).toBe(true);

    // The request GitHub asks for.
    const req = t.requests[0]!;
    expect(req.url).toBe("https://api.github.com/repos/cicord/cicord/releases?per_page=10");
    expect(req.init?.headers).toMatchObject({
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": expect.stringContaining("cicord-github-releases/0.1.0"),
    });
    expect(req.init?.headers?.["If-None-Match"]).toBeUndefined();
    expect(req.init?.timeoutMs).toBeGreaterThan(0);
  });

  test("first check announces the existing releases with announceExisting", async () => {
    const { t, gh } = setup({ announceExisting: true });
    gh.set("cicord/cicord", [rel(1, "v0.1.0", 300), rel(2, "v0.2.0", 200)]);
    await tick(t);
    expect(titles(t)).toEqual(["cicord/cicord v0.1.0", "cicord/cicord v0.2.0"]);
  });

  test("a new release is announced once; unchanged lists answer 304", async () => {
    const { t, gh } = setup();
    gh.set("cicord/cicord", [rel(1, "v0.1.0", 300)]);
    await tick(t);
    const seededEtag = state(t).etag;

    later(15);
    await tick(t);
    expect(t.requests.at(-1)!.init?.headers?.["If-None-Match"]).toBe(seededEtag);
    expect(t.sent).toEqual([]); // 304

    gh.add("cicord/cicord", rel(2, "v0.2.0", 1));
    later(15);
    await tick(t);
    expect(titles(t)).toEqual(["cicord/cicord v0.2.0"]);
    expect(t.sent[0]!.to).toBe("changelog");

    // Forced checks, the next poll: nothing twice.
    await checkFeeds(t.ctx, { force: true });
    later(15);
    await tick(t);
    expect(t.sent).toHaveLength(1);
    expect(state(t).recent).toEqual([2]);
  });

  test("feeds are checked every pollMinutes, not at every tick", async () => {
    const { t, gh } = setup({ pollMinutes: 30 });
    gh.set("cicord/cicord", [rel(1, "v0.1.0", 300)]);
    await tick(t);
    later(5);
    await tick(t);
    later(5);
    await tick(t);
    expect(t.requests).toHaveLength(1);
    later(20);
    await tick(t);
    expect(t.requests).toHaveLength(2);
  });

  test("drafts are skipped; pre-releases only where enabled, with a badge", async () => {
    const { t, gh } = setup({
      feeds: [
        { repo: "cicord/cicord", channel: "changelog" },
        { repo: "cicord/cicord", channel: "beta", includePrereleases: true, label: "Cicord beta" },
      ],
    });
    gh.set("cicord/cicord", [rel(1, "v0.1.0", 300)]);
    await tick(t);
    gh.add(
      "cicord/cicord",
      rel(2, "v0.2.0-rc.1", 30, { prerelease: true }),
      rel(3, "v0.2.0-draft", 20, { draft: true, published_at: null }),
      rel(4, "v0.2.0", 10),
    );
    later(15);
    await tick(t);
    const byChannel = (c: string) =>
      t.sent.filter((s) => s.to === c).map((s) => (s.message as MessagePayload).embeds![0]!);
    expect(byChannel("changelog").map((e) => e.title)).toEqual(["cicord/cicord v0.2.0"]);
    const beta = byChannel("beta");
    expect(beta.map((e) => e.title)).toEqual(["Cicord beta v0.2.0-rc.1", "Cicord beta v0.2.0"]);
    expect(beta[0]!.fields).toEqual([
      { name: "🧪 Pre-release", value: "Not a stable release.", inline: true },
    ]);
    expect(beta[1]!.fields).toBeUndefined();
    expect(titles(t).some((x) => x?.includes("draft"))).toBe(false);
  });

  test("a pre-release later marked as a full release is announced once", async () => {
    const { t, gh } = setup();
    gh.set("cicord/cicord", [rel(1, "v1.0.0", 300), rel(2, "v1.1.0", 30, { prerelease: true })]);
    await tick(t); // seeded at v1.0.0, the newest release this feed announces
    expect(state(t).cursor?.id).toBe(1);
    later(15);
    await tick(t);
    expect(t.sent).toEqual([]);
    gh.set("cicord/cicord", [rel(1, "v1.0.0", 315), rel(2, "v1.1.0", 45)]); // promoted
    later(15);
    await tick(t);
    later(15);
    await tick(t);
    expect(titles(t)).toEqual(["cicord/cicord v1.1.0"]);
  });

  test("at most 5 per check, oldest first; the rest at the next check", async () => {
    const { t, gh } = setup();
    gh.set("cicord/cicord", [rel(1, "v1.0.0", 1000)]);
    await tick(t);
    // Ids do not follow publication order (a draft published late): the date decides.
    gh.add(
      "cicord/cicord",
      ...[2, 3, 4, 5, 6, 7].map((n) => rel(n + 10, `v1.${n}.0`, 100 - n)),
      rel(8, "v1.1.0", 200),
    );
    later(15);
    await tick(t);
    expect(titles(t)).toEqual([
      "cicord/cicord v1.1.0",
      "cicord/cicord v1.2.0",
      "cicord/cicord v1.3.0",
      "cicord/cicord v1.4.0",
      "cicord/cicord v1.5.0",
    ]);
    expect(state(t).etag).toBeUndefined(); // not done: the next check reads the list again
    later(15);
    await tick(t);
    expect(titles(t).slice(5)).toEqual(["cicord/cicord v1.6.0", "cicord/cicord v1.7.0"]);
    expect(state(t).etag).toEqual(expect.any(String));
  });

  test("progress is saved after each post: a failed post is retried, never duplicated", async () => {
    const { t, gh } = setup();
    gh.set("cicord/cicord", [rel(1, "v1.0.0", 1000)]);
    await tick(t);
    gh.add("cicord/cicord", rel(2, "v1.1.0", 30), rel(3, "v1.2.0", 20), rel(4, "v1.3.0", 10));
    const server = t.ctx.server as { channel: (ref: string) => TextChannel };
    const real = server.channel.bind(server);
    let sends = 0;
    server.channel = (ref) => {
      const channel = real(ref);
      return {
        ...channel,
        send: async (m) => {
          if (++sends === 2) throw new Error("Missing Permissions");
          return channel.send(m);
        },
      };
    };
    later(15);
    await tick(t);
    expect(titles(t)).toEqual(["cicord/cicord v1.1.0"]);
    expect(t.logs.find((l) => l.level === "warn")?.fields?.["error"]).toContain(
      "Missing Permissions",
    );
    later(15);
    await tick(t);
    expect(titles(t)).toEqual([
      "cicord/cicord v1.1.0",
      "cicord/cicord v1.2.0",
      "cicord/cicord v1.3.0",
    ]);
  });

  test("a missing repository is logged once, without crashing", async () => {
    const { t } = setup({ feeds: [{ repo: "cicord/nope", channel: "changelog" }] });
    await tick(t);
    later(15);
    await tick(t);
    expect(t.requests).toHaveLength(2);
    const warnings = t.logs.filter((l) => l.message.includes("not found"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.fields).toEqual({ repo: "cicord/nope" });
    expect(t.sent).toEqual([]);
  });

  test("429 with Retry-After: every feed waits, then polling resumes", async () => {
    const { t, gh } = setup({
      feeds: [
        { repo: "cicord/cicord", channel: "changelog" },
        { repo: "cicord/other", channel: "beta" },
      ],
    });
    gh.set("cicord/cicord", []);
    gh.set("cicord/other", []);
    gh.override.set("cicord/cicord", { status: 429, headers: { "retry-after": "1800" } });
    await tick(t);
    expect(t.requests).toHaveLength(1); // the second feed is not asked
    expect(t.kv.get("backoff")).toEqual({ until: T0 + 1800_000, strikes: 1 });
    expect(t.logs.some((l) => l.level === "warn" && l.message.includes("rate limit"))).toBe(true);

    later(15);
    await tick(t);
    expect(t.requests).toHaveLength(1); // still waiting

    gh.override.clear();
    later(16);
    await tick(t);
    expect(t.requests.map((r) => r.url.split("/")[5])).toEqual(["cicord", "cicord", "other"]);
    expect(t.kv.has("backoff")).toBe(false);
  });

  test("rate-limit answers: Retry-After, X-RateLimit-Reset, or a growing backoff", async () => {
    expect(rateLimit(429, { "retry-after": "30" }, "", T0)).toEqual({ until: T0 + 30_000 });
    const reset = T0 / 1000 + 600;
    expect(
      rateLimit(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) }, "", T0),
    ).toEqual({ until: reset * 1000 + 1000 });
    expect(
      rateLimit(403, {}, '{"message":"You have exceeded a secondary rate limit"}', T0),
    ).toEqual({});
    expect(rateLimit(403, {}, '{"message":"Repository access blocked"}', T0)).toBeUndefined();
    expect(rateLimit(500, {}, "", T0)).toBeUndefined();

    const { t, gh } = setup();
    gh.override.set("cicord/cicord", { status: 429 });
    await tick(t);
    expect(t.kv.get("backoff")).toEqual({ until: T0 + MIN, strikes: 1 });
    later(1);
    await tick(t);
    expect(t.kv.get("backoff")).toEqual({ until: T0 + MIN + 2 * MIN, strikes: 2 });
  });

  test("network errors and unexpected answers are logged once, and retried", async () => {
    const { t, gh } = setup();
    gh.override.set("cicord/cicord", new Error("http.fetch GET …: timed out after 4s"));
    await tick(t);
    later(15);
    await tick(t);
    expect(t.logs.filter((l) => l.level === "warn")).toHaveLength(1);
    gh.override.set("cicord/cicord", { status: 502, body: "Bad gateway" });
    later(15);
    await tick(t);
    expect(t.logs.filter((l) => l.level === "warn").at(-1)!.fields?.["error"]).toBe(
      "GitHub answered HTTP 502",
    );
    gh.override.clear();
    gh.set("cicord/cicord", [rel(1, "v1.0.0", 10)]);
    later(15);
    await tick(t);
    expect(state(t).seeded).toBe(true);
    expect(state(t).lastError).toBeUndefined();
  });

  test("a check stops starting feeds after its time budget", async () => {
    const gh = new FakeGitHub();
    const slow = (url: string, init?: { headers?: Record<string, string> }) => {
      vi.setSystemTime(Date.now() + 2_000);
      return gh.fetch(url, init);
    };
    const feeds = ["a", "b", "c"].map((n) => ({ repo: `cicord/${n}`, channel: "changelog" }));
    for (const f of feeds) gh.set(f.repo, []);
    const t = createTestContext({
      schema,
      config: { feeds },
      grants,
      fetch: slow,
      channels: { changelog: { name: "changelog" } },
    });
    const s = await checkFeeds(t.ctx);
    expect(s.results.map((r) => r.kind)).toEqual(["seeded", "seeded", "deferred"]);
    vi.setSystemTime(Date.now() + 5 * MIN);
    await tick(t);
    expect(t.requests.at(-1)!.url).toContain("cicord/c"); // the deferred feed goes first
  });
});

describe("messages", () => {
  test("the embed: title, link, notes, author, footer, timestamp; no ping by default", async () => {
    const { t, gh } = setup({
      announceExisting: true,
      feeds: [{ repo: "cicord/cicord", channel: "changelog", label: "Cicord" }],
    });
    gh.set("cicord/cicord", [
      rel(1, "v0.2.0", 10, { name: "Subcommands", body: "## What's new\r\n- autocomplete" }),
    ]);
    await tick(t);
    const m = t.sent[0]!.message as MessagePayload;
    expect(m.content).toBeUndefined();
    expect(m.allowedMentions).toEqual({ users: false, roles: false, everyone: false });
    expect(m.embeds![0]).toEqual({
      title: "Cicord v0.2.0",
      url: "https://github.com/cicord/cicord/releases/tag/v0.2.0",
      description: "**Subcommands**\n\n## What's new\n- autocomplete",
      color: "#2da44e",
      author: {
        name: "octocat",
        url: "https://github.com/octocat",
        iconUrl: "https://avatars.githubusercontent.com/u/1",
      },
      footer: { text: "cicord/cicord" },
      timestamp: new Date(T0 - 10 * MIN).toISOString(),
    });
  });

  test("mentionRole pings that role only", async () => {
    const { t, gh } = setup({
      announceExisting: true,
      feeds: [{ repo: "cicord/cicord", channel: "changelog", mentionRole: "updates" }],
    });
    gh.set("cicord/cicord", [rel(1, "v0.2.0", 10, { body: "Thanks @everyone and <@&999>!" })]);
    await tick(t);
    const m = t.sent[0]!.message as MessagePayload;
    expect(m.content).toBe("<@&500>");
    expect(m.allowedMentions).toEqual({ users: false, roles: true, everyone: false });
    expect(m.embeds![0]!.description).toContain("@everyone"); // in the embed: never pings
  });

  test("long notes are cut to Discord's limit with a link to the full notes", async () => {
    const body = [
      "```",
      ...Array.from({ length: 600 }, (_, i) => `line ${i} of the changelog`),
    ].join("\n");
    const { t, gh } = setup({ announceExisting: true });
    gh.set("cicord/cicord", [rel(1, "v1.0.0", 10, { body })]);
    await tick(t);
    const d = embedOf(t).description!;
    expect(d.length).toBeLessThanOrEqual(DESCRIPTION_LIMIT);
    expect(
      d.endsWith("… [Read the full notes](https://github.com/cicord/cicord/releases/tag/v1.0.0)"),
    ).toBe(true);
    expect(d).toMatch(/of the changelog\n```\n\n…/); // cut at a line, code block closed
    expect(trimNotes("short", "https://x")).toBe("short");
    const emoji = trimNotes("😀".repeat(3000), "u", 100);
    expect(emoji.length).toBeLessThanOrEqual(100);
    expect(emoji).not.toContain("�");
  });
});

describe("/changelog", () => {
  test("the command has subcommands and is for server managers", () => {
    const c = plugin.commands!["changelog"] as { permissions?: string[]; subcommands?: object };
    expect(c.permissions).toEqual(["ManageServer"]);
    expect(Object.keys(c.subcommands ?? {})).toEqual(["latest", "check"]);
  });

  test("autocomplete lists the configured repositories once", async () => {
    const { t } = setup({
      feeds: [
        { repo: "cicord/cicord", channel: "changelog", label: "Cicord" },
        { repo: "cicord/cicord", channel: "beta", includePrereleases: true },
        { repo: "nodejs/node", channel: "changelog" },
      ],
    });
    const all = await runAutocomplete(plugin, t, "changelog latest", {
      user: "1",
      focused: "repo",
    });
    expect(all).toEqual([
      { name: "Cicord (cicord/cicord)", value: "cicord/cicord" },
      { name: "nodejs/node", value: "nodejs/node" },
    ]);
    const node = await runAutocomplete(plugin, t, "changelog latest", {
      user: "1",
      focused: "repo",
      value: "NODE",
    });
    expect(node).toEqual([{ name: "nodejs/node", value: "nodejs/node" }]);
  });

  test("latest: a public embed of the newest release, from the last check", async () => {
    const { t, gh } = setup();
    gh.set("cicord/cicord", [rel(1, "v0.1.0", 300), rel(2, "v0.2.0", 200)]);
    await tick(t);
    const r = await runCommand(plugin, t, "changelog latest", {
      user: "1",
      options: { repo: "Cicord/Cicord" },
    });
    expect(t.requests).toHaveLength(1); // answered from the stored check
    const reply = r.replies[0] as MessagePayload & { ephemeral?: boolean };
    expect(reply.ephemeral).toBeUndefined();
    expect(reply.embeds![0]!.title).toBe("cicord/cicord v0.2.0");
    expect(reply.allowedMentions).toEqual({ users: false, roles: false, everyone: false });
  });

  test("latest: asks GitHub before the first check; refuses unknown repositories", async () => {
    const { t, gh } = setup();
    gh.set("cicord/cicord", [
      rel(1, "v0.1.0", 300),
      rel(2, "v0.2.0-rc.1", 10, { prerelease: true }),
    ]);
    const r = await runCommand(plugin, t, "changelog latest", {
      user: "1",
      options: { repo: "cicord/cicord" },
    });
    expect((r.replies[0] as MessagePayload).embeds![0]!.title).toBe("cicord/cicord v0.1.0");
    expect(t.kv.size).toBe(0); // the feed's state is left to the poll

    const unknown = await runCommand(plugin, t, "changelog latest", {
      user: "1",
      options: { repo: "evil/proxy" },
    });
    expect(unknown.replies[0]).toMatchObject({
      ephemeral: true,
      content: expect.stringContaining("not announced here"),
    });
    expect(t.requests).toHaveLength(1);
  });

  test("check: forces a check now and answers an ephemeral summary", async () => {
    const { t, gh } = setup({
      feeds: [
        { repo: "cicord/cicord", channel: "changelog", label: "Cicord" },
        { repo: "cicord/gone", channel: "beta" },
      ],
    });
    gh.set("cicord/cicord", [rel(1, "v0.1.0", 300)]);
    await tick(t);
    gh.add("cicord/cicord", rel(2, "v0.2.0", 1));
    const r = await runCommand(plugin, t, "changelog check", { user: "1" }); // no wait for pollMinutes
    expect(r.deferred).toEqual({ ephemeral: true });
    expect(titles(t)).toEqual(["Cicord v0.2.0"]);
    const reply = r.replies[0] as MessagePayload & { ephemeral?: boolean };
    expect(reply.ephemeral).toBe(true);
    expect(reply.content).toBe(
      [
        "✅ **Cicord** → <#channel-changelog>: 1 new release announced",
        "⚠️ **cicord/gone** → <#channel-beta>: repository not found (missing, renamed or private)",
      ].join("\n"),
    );
  });

  test("check: says when GitHub's rate limit is being waited out", async () => {
    const { t, gh } = setup();
    gh.override.set("cicord/cicord", { status: 429, headers: { "retry-after": "600" } });
    await tick(t);
    const r = await runCommand(plugin, t, "changelog check", { user: "1" });
    expect((r.replies[0] as MessagePayload).content).toBe(
      `GitHub's rate limit was reached: the next check is <t:${T0 / 1000 + 600}:R>.`,
    );
    expect(t.requests).toHaveLength(1);
  });
});
