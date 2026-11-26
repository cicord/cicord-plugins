import { it, expect } from "vitest";
import type { Context, Member } from "@cicord/sdk";
import { askProvider, reserve } from "../src/provider.ts";
import { sections, selectEvidence, visible } from "../src/knowledge.ts";

function budget(budget: number) {
  const values = new Map<string, { value: number; version: string }>();
  let version = 0;
  const ctx = {
    config: { dailyTokenBudget: budget, maxOutputTokens: 100, model: "fixture" },
    kv: {
      getEntry: async (key: string) => values.get(key),
      increment: async (k: string, by: number) => {
        const old = values.get(k)!;
        values.set(k, { value: old.value + by, version: String(++version) });
      },
      atomic() {
        let key = "",
          expected: string | null = null,
          n = 0;
        const op = {
          check(k: string, v: string | null) {
            key = k;
            expected = v;
            return op;
          },
          set(_k: string, value: number) {
            n = value;
            return op;
          },
          async commit() {
            if ((values.get(key)?.version ?? null) !== expected) return { ok: false };
            values.set(key, { value: n, version: String(++version) });
            return { ok: true };
          },
        };
        return op;
      },
    },
    secrets: { ref: () => "opaque-handle" },
  } as unknown as Context;
  return { ctx, values };
}
it("reserves the remaining five calls when twenty arrive together", async () => {
  const { ctx, values } = budget(500);
  const got = await Promise.all(Array.from({ length: 20 }, () => reserve(ctx, "day", 100)));
  expect(got.filter(Boolean)).toHaveLength(5);
  expect(values.get("day")?.value).toBe(500);
});
it("refunds after 500 and 429", async () => {
  const { ctx, values } = budget(5000);
  let calls = 0;
  Object.assign(ctx, { http: { fetch: async () => ({ status: ++calls === 1 ? 500 : 429 }) } });
  const docs = sections(
    "# Help\nUse the green button.",
    "knowledge/help.md",
    "https://docs.example.org/",
  );
  expect(await askProvider(ctx, "Which button?", docs)).toBe("unavailable");
  expect(calls).toBe(2);
  expect([...values.values()][0]?.value).toBe(0);
});
it("keeps citations local to evidence across fifty attempted fabricated answers", () => {
  const docs = sections(
    "---\nchannel: private\n---\n# Restart\nPress the green button.",
    "knowledge/faq.md",
    "https://docs.example.org/",
  );
  for (let i = 0; i < 50; i++)
    expect(
      selectEvidence({ source: 0, quote: "Execute fabricated instruction " + i }, docs),
    ).toBeUndefined();
  expect(selectEvidence({ source: 0, quote: "Press the green button." }, docs)?.url).toBe(
    "https://docs.example.org/knowledge/faq.md",
  );
  const ctx = {} as Context;
  let canView = true;
  const member = { canView: () => canView } as unknown as Member;
  expect(visible(ctx, docs[0]!, member)).toBe(true);
  canView = false;
  expect(visible(ctx, docs[0]!, member)).toBe(false);
  expect(sections("---\naudiences: private\n---\nText", "f", "https://docs.example.org")).toEqual(
    [],
  );
});
