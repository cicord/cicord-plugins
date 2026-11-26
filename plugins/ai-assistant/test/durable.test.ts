import { it, expect } from "vite-plus/test";
import type { Context, CommandInteraction, Json, MessageInput } from "@cicord/sdk";
import plugin from "../src/index.ts";

function fixture() {
  const records = new Map<string, Json>();
  let calls = 0,
    sourceVisible = true,
    revokeDuringProvider = false;
  const privateText = "Private procedure: press the green button.";
  const member = {
    id: "user",
    hasRole: () => false,
    canView: (ref: unknown) => (ref === "staff" ? sourceVisible : true),
  };
  const channel = { id: "channel", type: "text" };
  const ctx = {
    config: {
      enabled: true,
      allowedRoles: [],
      excludedRoles: [],
      memberInterval: 1,
      channelInterval: 1,
      minRelevance: 0,
      model: "synthetic",
      maxOutputTokens: 100,
      documentBaseURL: "https://example.org",
      fallbackContact: { text: "Help", url: "https://example.org/help" },
    },
    kv: {
      get: async (k: string) => records.get(k),
      set: async (k: string, v: Json) => {
        records.set(k, v);
      },
      delete: async (k: string) => {
        records.delete(k);
      },
      list: async ({ prefix }: { prefix: string }) => ({
        items: [...records]
          .filter(([k]) => k.startsWith(prefix))
          .map(([key, value]) => ({ key, value })),
      }),
      atomic: () => {
        const b = { check: () => b, set: () => b, commit: async () => ({ ok: true }) };
        return b;
      },
    },
    server: {
      member: async () => member,
      channel: () => channel,
      audience: () => ({ public: true }),
    },
    files: {
      list: async () => ["knowledge/private.md"],
      read: async () => "---\nchannel: staff\n---\n# Procedure\n" + privateText,
    },
    index: (name: string) => ({
      search: async () =>
        name === "knowledge"
          ? [{ score: 1, meta: { path: "knowledge/private.md", section: 0 } }]
          : [],
    }),
    features: { enabled: () => false },
    secrets: { has: () => true, ref: () => "opaque" },
    http: {
      fetch: async () => {
        calls++;
        if (revokeDuringProvider) sourceVisible = false;
        return {
          status: 200,
          headers: {},
          json: async () => ({
            content: [{ type: "text", text: JSON.stringify({ source: 0, quote: privateText }) }],
          }),
        };
      },
    },
    i18n: { t: (key: string) => key },
  } as unknown as Context;
  const queued: { name: string; payload: Json | undefined }[] = [];
  const replies: MessageInput[] = [];
  const interaction = {
    id: "question",
    user: { id: "user" },
    member,
    channel,
    options: { question: "my private question" },
    deferTask: async (name: string, payload?: Json) => {
      queued.push({ name, payload });
    },
    reply: async (p: MessageInput) => {
      replies.push(p);
    },
  } as unknown as CommandInteraction;
  const command = plugin.commands!.ask as unknown as {
    subcommands: { question: { run(ctx: Context, it: CommandInteraction): Promise<void> } };
  };
  const run = () => command.subcommands.question.run(ctx, interaction);
  const deliver = () =>
    plugin.tasks!.question!(
      ctx,
      { id: "question" },
      {
        id: "job",
        attempt: 1,
        interaction: {
          id: "question",
          userId: "user",
          channelId: "channel",
          expiresAt: new Date(Date.now() + 60000),
          reply: async (p) => {
            replies.push(p);
          },
        },
      },
    );
  return {
    ctx,
    records,
    queued,
    replies,
    run,
    deliver,
    calls: () => calls,
    revoke: () => {
      revokeDuringProvider = true;
    },
  };
}
it("hands off only a request ID and restores a private question from owner storage", async () => {
  const f = fixture();
  await f.run();
  expect(f.calls()).toBe(0);
  expect(f.queued).toEqual([{ name: "question", payload: { id: "question" } }]);
  expect(JSON.stringify(f.queued)).not.toContain("my private question");
  await f.deliver();
  expect(f.calls()).toBe(1);
  expect(f.replies).toHaveLength(1);
  expect(JSON.stringify(f.replies)).toContain("Private procedure");
  expect(f.records.has("user:user:pending:question")).toBe(false);
});
it("erases pending private questions before a restored task can call the provider", async () => {
  const f = fixture();
  await f.run();
  await plugin.privacy!.erase(f.ctx, "user");
  await f.deliver();
  expect(f.calls()).toBe(0);
  expect(f.replies).toHaveLength(0);
});
it("checks the final member audience after the synthetic provider response", async () => {
  const f = fixture();
  await f.run();
  f.revoke();
  await f.deliver();
  expect(f.calls()).toBe(1);
  expect(JSON.stringify(f.replies)).not.toContain("Private procedure");
});

it("exports only metadata for a pending private question", async () => {
  const f = fixture();
  await f.run();
  const data = await plugin.privacy!.export(f.ctx, "user");
  expect(JSON.stringify(data)).not.toContain("my private question");
  expect(JSON.stringify(data)).toContain("restricted");
});
