import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createTestContext } from "@cicord/sdk/testing";
import schema from "../config.schema.json" with { type: "json" };
import en from "../locales/en.json" with { type: "json" };
import fr from "../locales/fr.json" with { type: "json" };
import plugin from "../src/index.ts";
import { parseFeed } from "../src/parse.ts";

type Item = { id: string; title: string; url: string };
const item = (n: number): Item => ({
  id: "post-" + n,
  title: "Post " + n,
  url: "https://news.example.org/" + n,
});
/** A JSON Feed lists the newest entry first. */
const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, k) => item(to - k));
const FORBIDDEN =
  "discord create message: discord: missing permissions (HTTP 403 50013: Missing Permissions)";

function setup(feeds: Record<string, unknown>[], items: Item[]) {
  const source = { items, status: 200 };
  const t = createTestContext({
    schema,
    locales: { en, fr },
    config: { enabled: true, pollMinutes: 5, feeds },
    channels: { general: { name: "General" } },
    roles: { readers: { name: "Readers" } },
    fetch: async () => ({
      status: source.status,
      body: JSON.stringify({ version: "https://jsonfeed.org/version/1.1", items: source.items }),
    }),
  });
  const notices = new Map<string, string | null>();
  // Send failures: `before` throws without reaching Discord, `after` once Discord posted.
  const failures: { error: string; after?: boolean }[] = [];
  // Like the runtime, a transaction takes fewer than 128 checks and operations.
  const kv = t.ctx.kv,
    atomic = kv.atomic.bind(kv);
  Object.assign(kv, {
    atomic() {
      const tx = atomic();
      let count = 0;
      const counted =
        <K extends "check" | "set" | "delete">(name: K) =>
        (...args: unknown[]) => {
          if (++count >= 128) throw new TypeError("kv.atomic: closed or full transaction");
          (tx[name] as (...a: unknown[]) => unknown)(...args);
          return wrapper;
        };
      const wrapper = {
        check: counted("check"),
        set: counted("set"),
        delete: counted("delete"),
        commit: () => tx.commit(),
      };
      return wrapper;
    },
  });
  const server = t.ctx.server;
  const channel = server.channel.bind(server);
  Object.assign(t.ctx, {
    status: { set: (k: string, v: string | null) => notices.set(k, v) },
    server: Object.assign(Object.create(server), {
      channel: (ref: string) => ({
        async send(message: Parameters<ReturnType<typeof channel>["send"]>[0]) {
          const failure = failures.shift();
          if (failure && !failure.after) throw new Error(failure.error);
          const sent = await channel(ref).send(message);
          if (failure) throw new Error(failure.error);
          return sent;
        },
      }),
    }),
  });
  /** One cron tick, then every check task it enqueued; returns the task errors. */
  const tick = async () => {
    await plugin.schedules!.poll!.run(t.ctx);
    const errors: unknown[] = [];
    for (const task of t.scheduled.splice(0))
      await Promise.resolve(plugin.tasks!.check!(t.ctx, task.payload)).catch((e: unknown) =>
        errors.push(e),
      );
    return errors;
  };
  const check = async (id: string) => plugin.tasks!.check!(t.ctx, { id });
  const titles = () => t.sent.map((s) => (s.message as { content: string }).content);
  return { t, source, notices, failures, tick, check, titles };
}
const later = (minutes: number) => vi.setSystemTime(Date.now() + minutes * 60000);
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse("2026-11-20T10:00:00Z"));
});
afterEach(() => vi.useRealTimers());

describe("feeds", () => {
  it("reads RSS and Atom, rejects entities declared by documents", () => {
    expect(
      parseFeed(
        "<rss><channel><item><guid>x</guid><title><![CDATA[A & B]]></title><link>https://example.org/news</link></item></channel></rss>",
      )[0]?.title,
    ).toBe("A & B");
    expect(
      parseFeed(
        '<feed><entry><id>x</id><title>A &amp; B</title><link href="https://example.org/news" /></entry></feed>',
      )[0]?.url,
    ).toBe("https://example.org/news");
    expect(() => parseFeed("<!DOCTYPE x><rss/>")).toThrow();
  });

  it("records the existing backlog on a feed's first check, then posts only new entries", async () => {
    const f = setup(
      [
        { id: "news", channel: "general", url: "https://news.example.org/a" },
        { id: "digest", channel: "general", url: "https://news.example.org/b", backlog: 1 },
      ],
      range(1, 150),
    );
    expect(await f.tick()).toEqual([]);
    // Only `digest` publishes its newest existing entry; nothing of the 30-entry backlog else.
    expect(f.titles()).toEqual(["**Post 150**\nhttps://news.example.org/150"]);
    f.source.items = range(1, 152);
    later(5);
    await f.tick();
    expect(f.titles().slice(1)).toEqual([
      "**Post 151**\nhttps://news.example.org/151",
      "**Post 152**\nhttps://news.example.org/152",
      "**Post 151**\nhttps://news.example.org/151",
      "**Post 152**\nhttps://news.example.org/152",
    ]);
    // Renaming a feed id is a new feed: its backlog is recorded again, not posted.
    f.t.ctx.config.feeds![0]!.id = "renamed";
    later(5);
    await f.tick();
    expect(f.t.sent).toHaveLength(5);
    // A feed checked by an earlier version (state without `seeded`) keeps publishing.
    await f.t.ctx.kv.set("state:renamed", { due: 0, errors: 0 });
    await f.t.ctx.kv.delete("guid:renamed:post-152");
    later(5);
    await f.tick();
    expect(f.titles().at(-1)).toBe("**Post 152**\nhttps://news.example.org/152");
  });

  it("retries an ambiguous send with the claim's nonce and never posts twice", async () => {
    const f = setup([{ id: "news", channel: "general", url: "https://news.example.org/" }], []);
    await f.tick(); // seeds an empty feed
    f.source.items = range(1, 2);
    later(5);
    // Discord posted entry 1 but the acknowledgement was lost.
    f.failures.push({ error: "discord create message: context deadline exceeded", after: true });
    expect(await f.tick()).toHaveLength(1);
    vi.advanceTimersByTime(1000); // the scheduler's first retry
    await f.check("news");
    expect(f.titles()).toEqual([
      "**Post 1**\nhttps://news.example.org/1",
      "**Post 2**\nhttps://news.example.org/2",
    ]);
    const nonces = f.t.sent.map((s) => (s.message as { nonce: string }).nonce);
    expect(new Set(nonces).size).toBe(2);
    expect(await f.t.ctx.kv.get("guid:news:post-1")).toBe("sent");
  });

  it("a run cut by the deadline after its claim is retried safely; a stale claim is flagged", async () => {
    const f = setup([{ id: "news", channel: "general", url: "https://news.example.org/" }], []);
    await f.tick();
    f.source.items = range(1, 2);
    later(5);
    // What a run killed between the claim and the send leaves behind.
    const now = Date.now();
    await f.t.ctx.kv.set("state:news", { due: 0, errors: 0, seeded: true, lease: now + 12000 });
    await f.t.ctx.kv.set("guid:news:post-1", { nonce: "fcut", first: now });
    vi.advanceTimersByTime(1000);
    await expect(f.check("news")).rejects.toThrow("already running");
    vi.advanceTimersByTime(12000);
    await f.check("news");
    expect(f.t.sent.map((s) => (s.message as { nonce: string }).nonce)[0]).toBe("fcut");
    expect(f.t.sent).toHaveLength(2);
    // A claim older than the nonce window may have been posted: never resent, but reported.
    f.source.items = range(1, 4);
    await f.t.ctx.kv.set("guid:news:post-3", { nonce: "fold", first: Date.now() - 120000 });
    later(5);
    await f.tick();
    expect(await f.t.ctx.kv.get("guid:news:post-3")).toBe("uncertain");
    expect(f.notices.get("delivery:news")).toBe(
      "Delivery of “Post 3” is uncertain and it will not be sent again. Check the channel.",
    );
    expect(f.titles().at(-1)).toBe("**Post 4**\nhttps://news.example.org/4");
    expect(f.t.sent).toHaveLength(3);
    // The notice stays until a later check delivers an entry.
    f.source.items = range(1, 5);
    later(5);
    await f.tick();
    expect(f.notices.get("delivery:news")).toBeNull();
  });

  it("a definite refusal keeps the entry unsent, names the problem and clears on success", async () => {
    const f = setup([{ id: "news", channel: "general", url: "https://news.example.org/" }], []);
    await f.tick();
    f.source.items = range(1, 2);
    later(5);
    f.failures.push({ error: FORBIDDEN });
    expect(await f.tick()).toEqual([]);
    expect(f.t.sent).toHaveLength(0);
    expect(await f.t.ctx.kv.get("guid:news:post-1")).toBeUndefined();
    expect(await f.t.ctx.kv.get("guid:news:post-2")).toBeUndefined();
    expect(f.notices.get("delivery:news")).toContain("missing permissions");
    // Fixed permissions: the next check posts both entries, oldest first.
    later(5);
    await f.tick();
    expect(f.titles()).toEqual([
      "**Post 1**\nhttps://news.example.org/1",
      "**Post 2**\nhttps://news.example.org/2",
    ]);
    expect(f.notices.get("delivery:news")).toBeNull();
  });

  it("a rejected entry is skipped for good and the following entries are still posted", async () => {
    const f = setup([{ id: "news", channel: "general", url: "https://news.example.org/" }], []);
    await f.tick();
    f.source.items = range(1, 3);
    later(5);
    f.failures.push({
      error:
        'discord SendMessage: discord: bad request (HTTP 400 50035: Invalid Form Body {"content":"too long"})',
    });
    expect(await f.tick()).toEqual([]);
    expect(f.titles()).toEqual([
      "**Post 2**\nhttps://news.example.org/2",
      "**Post 3**\nhttps://news.example.org/3",
    ]);
    expect(await f.t.ctx.kv.get("guid:news:post-1")).toBe("failed");
    expect([...f.notices].filter(([k, v]) => k === "delivery:news" && v)).toEqual([
      [
        "delivery:news",
        "Discord rejected the entry “Post 1” (rejected message). It is skipped and will not be sent again.",
      ],
    ]);
    // The next check does not retry it.
    f.source.items = range(1, 4);
    later(5);
    await f.tick();
    expect(f.titles().slice(2)).toEqual(["**Post 4**\nhttps://news.example.org/4"]);
  });

  it("keeps a GUID across an edit and backs off a failing feed", async () => {
    const f = setup([{ id: "news", channel: "general", url: "https://news.example.org/" }], []);
    await f.tick();
    f.source.items = [item(1)];
    later(5);
    await f.tick();
    f.source.items = [{ ...item(1), title: "Updated" }];
    later(5);
    await f.tick();
    expect(f.t.sent).toHaveLength(1);
    f.source.status = 503;
    for (let n = 0; n < 5; n++) {
      later(61);
      await f.tick();
    }
    const retry = (await f.t.ctx.kv.get<{ due: number }>("state:news"))!;
    expect(retry.due - Date.now()).toBe(3600000);
    expect(f.notices.get("news")).toBe("Feed unavailable. Retrying in 60 min.");
    const requests = f.t.requests.length;
    later(30);
    await f.tick();
    expect(f.t.requests.length).toBe(requests);
  });
});
