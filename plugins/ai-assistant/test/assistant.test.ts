import { it, expect } from "vite-plus/test";
import type { Context, Member } from "@cicord/sdk";
import { askProvider } from "../src/provider.ts";
import { sections, selectEvidence, visible } from "../src/knowledge.ts";

function provider(statuses: number[], exhausted = false) {
  let calls = 0;
  const ctx = {
    config: { maxOutputTokens: 100, model: "fixture" },
    secrets: { ref: () => "opaque-handle" },
    http: {
      fetch: async () => ({
        status: statuses[calls++],
        headers: exhausted ? { "x-cicord-budget": "exhausted" } : {},
      }),
    },
  } as unknown as Context;
  return { ctx, calls: () => calls };
}
it("returns a host budget refusal without retrying the provider", async () => {
  const fake = provider([429], true);
  expect(await askProvider(fake.ctx, "Which button?", [])).toBe("budget");
  expect(fake.calls()).toBe(1);
});
it("backs off once after provider 500 then 429", async () => {
  const fake = provider([500, 429]);
  expect(await askProvider(fake.ctx, "Which button?", [])).toBe("unavailable");
  expect(fake.calls()).toBe(2);
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
