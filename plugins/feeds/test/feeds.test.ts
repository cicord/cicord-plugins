import { describe, it, expect } from "vite-plus/test";
import plugin from "../src/index.ts";
import { parseFeed } from "../src/parse.ts";
import type { Context } from "@cicord/sdk";

const fixture = {
  version: "https://jsonfeed.org/version/1.1",
  items: [{ id: "stable", title: "First", url: "https://news.example.org/first" }],
};
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
  it("keeps a GUID claim across polls and backs off each failing feed independently", async () => {
    const values = new Map<string, unknown>(),
      notices = new Map<string, unknown>();
    let sends = 0,
      calls = 0,
      broken = false;
    const ctx = {
      config: {
        enabled: true,
        pollMinutes: 5,
        feeds: [{ id: "news", channel: "help", url: "https://news.example.org/" }],
      },
      http: {
        async fetch() {
          calls++;
          return { status: broken ? 503 : 200, text: async () => JSON.stringify(fixture) };
        },
      },
      server: {
        channel: () => ({
          send: async () => {
            sends++;
          },
        }),
      },
      status: { set: (k: string, v: string) => notices.set(k, v) },
      i18n: { t: (k: string) => k },
      kv: {
        getEntry: async (k: string) =>
          values.has(k) ? { value: values.get(k), version: "v" } : undefined,
        set: async (k: string, v: unknown) => values.set(k, v),
        atomic: () => {
          let key = "",
            value: unknown,
            absent = false;
          const op = {
            check(k: string, v: unknown) {
              key = k;
              absent = v === null;
              return op;
            },
            set(_k: string, v: unknown) {
              value = v;
              return op;
            },
            async commit() {
              if (absent && values.has(key)) return { ok: false };
              values.set(key, value);
              return { ok: true };
            },
          };
          return op;
        },
      },
    } as unknown as Context;
    const poll = () => plugin.schedules!.poll!.run(ctx);
    await poll();
    values.delete("state:news");
    fixture.items[0]!.title = "Updated";
    await poll();
    expect(sends).toBe(1);
    broken = true;
    for (let n = 0; n < 5; n++) {
      const s = values.get("state:news") as { due: number };
      s.due = 0;
      await poll();
    }
    const retry = values.get("state:news") as { due: number };
    expect(retry.due - Date.now()).toBeGreaterThan(3590000);
    expect(notices.get("news")).toBe("backoff");
    await poll();
    expect(calls).toBe(7);
  });
});
