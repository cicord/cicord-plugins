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
it("does not retry a potentially charged provider 500", async () => {
  const fake = provider([500, 429]);
  expect(await askProvider(fake.ctx, "Which button?", [])).toBe("unavailable");
  expect(fake.calls()).toBe(1);
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

it("does not retry an ambiguous network failure", async () => {
  let charges = 0;
  const ctx = {
    config: { model: "fixture", maxOutputTokens: 100 },
    secrets: { ref: () => "opaque" },
    http: {
      fetch: async () => {
        charges++;
        throw new Error("response lost after charge");
      },
    },
  } as unknown as Context;
  expect(await askProvider(ctx, "question", [])).toBe("unavailable");
  expect(charges).toBe(1);
});

function scripted(replies: { status: number; headers?: Record<string, string> }[]) {
  const timeouts: (number | undefined)[] = [];
  const docs = sections("# Restart\nPress the green button.", "knowledge/faq.md", "https://d.example/");
  const ctx = {
    config: { maxOutputTokens: 100, model: "fixture" },
    secrets: { ref: () => "opaque-handle" },
    http: {
      fetch: async (_url: string, init: { timeoutMs?: number }) => {
        timeouts.push(init.timeoutMs);
        const r = replies[timeouts.length - 1]!;
        return {
          status: r.status,
          headers: r.headers ?? {},
          json: async () => ({
            content: [{ type: "text", text: JSON.stringify({ source: 0, quote: "Press the green button." }) }],
          }),
        };
      },
    },
  } as unknown as Context;
  return { ctx, docs, timeouts };
}
it("retries once after an unbilled overload or rate limit, within the deadline", async () => {
  for (const first of [{ status: 529 }, { status: 429, headers: { "retry-after": "0" } }]) {
    const fake = scripted([first, { status: 200 }]);
    const result = await askProvider(fake.ctx, "Which button?", fake.docs, [], Date.now() + 8000);
    expect(typeof result === "object" && result.text).toBe("Press the green button.");
    expect(fake.timeouts).toHaveLength(2);
  }
  const twice = scripted([{ status: 529 }, { status: 529 }, { status: 200 }]);
  expect(await askProvider(twice.ctx, "q", twice.docs, [], Date.now() + 8000)).toBe("unavailable");
  expect(twice.timeouts).toHaveLength(2);
});
it("does not retry a spend-cap 429 or a 500", async () => {
  for (const first of [{ status: 429 }, { status: 500 }, { status: 503 }]) {
    const fake = scripted([first, { status: 200 }]);
    expect(await askProvider(fake.ctx, "q", fake.docs, [], Date.now() + 8000)).toBe("unavailable");
    expect(fake.timeouts).toHaveLength(1);
  }
});
it("gives the provider the remaining handler time and never starts a call that cannot finish", async () => {
  const fake = scripted([{ status: 200 }]);
  await askProvider(fake.ctx, "q", fake.docs, [], Date.now() + 8000);
  expect(fake.timeouts[0]).toBeGreaterThan(7000);
  expect(fake.timeouts[0]).toBeLessThanOrEqual(8000);
  const late = scripted([{ status: 200 }]);
  expect(await askProvider(late.ctx, "q", late.docs, [], Date.now() + 1500)).toBe("unavailable");
  expect(late.timeouts).toHaveLength(0);
  // No retry when the backoff would leave too little time for a second call.
  const tight = scripted([{ status: 529 }, { status: 200 }]);
  expect(await askProvider(tight.ctx, "q", tight.docs, [], Date.now() + 2300)).toBe("unavailable");
  expect(tight.timeouts).toHaveLength(1);
});
