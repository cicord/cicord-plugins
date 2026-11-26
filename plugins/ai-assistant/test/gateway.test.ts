import { describe, expect, it } from "vite-plus/test";
import { createTestContext, type TestHarness } from "@cicord/sdk/testing";
import type { Message } from "@cicord/sdk";
import plugin from "../src/index.ts";
import schema from "../config.schema.json" with { type: "json" };
import en from "../locales/en.json" with { type: "json" };

// Member 12 holds the excluded role. Help questions arrive in #help.
function harness() {
  return createTestContext({
    schema,
    config: {
      enabled: true,
      documentBaseURL: "https://docs.example.org/",
      fallbackContact: { text: "Help desk", url: "https://help.example.org/" },
      channels: ["help"],
      excludedRoles: ["muted"],
      memberInterval: 30,
      channelInterval: 5,
    },
    locales: { en },
    features: ["helpChannels"],
    roles: { muted: { name: "muted" } },
    members: [{ id: "10" }, { id: "11" }, { id: "12", roles: ["muted"] }, { id: "13" }],
    server: {
      ownerId: "10",
      everyonePermissions: ["ViewChannel", "ReadMessageHistory", "SendMessages"],
    },
    channels: { help: { name: "help" } },
  });
}
function say(h: TestHarness, uid: string, text: string): Message {
  return { ...h.receive(h.channel("help")!.id, h.member(uid)!.user, text), member: h.member(uid)! };
}
const helpTasks = (h: TestHarness) => h.scheduled.filter((t) => t.task === "help");
async function runHelp(h: TestHarness, index = 0) {
  await plugin.tasks!.help!(h.ctx, helpTasks(h)[index]!.payload, {
    id: helpTasks(h)[index]!.id,
    attempt: 1,
  });
}

describe("help channel admission (C-08)", () => {
  it("queues one question per cooldown and never answers the rest publicly", async () => {
    const h = harness();
    for (const text of ["first", "second", "third"])
      await plugin.events!.messageCreate!(h.ctx, say(h, "11", text));
    expect(helpTasks(h)).toHaveLength(1);
    // The channel cooldown also holds back another member's question.
    await plugin.events!.messageCreate!(h.ctx, say(h, "13", "me too"));
    expect(helpTasks(h)).toHaveLength(1);
    expect(h.sent).toHaveLength(0);
    expect(h.typing).toHaveLength(0);

    await runHelp(h);
    // The admitted question gets an answer (here the fallback), not "Please wait".
    expect(h.sent).toHaveLength(1);
    expect(JSON.stringify(h.sent[0]!.message)).toContain("help.example.org");
    expect(JSON.stringify(h.sent)).not.toContain(en.limited);
    expect(h.typing).toHaveLength(1);
  });

  it("ignores an excluded member without a reply, a typing indicator or a task", async () => {
    const h = harness();
    await plugin.events!.messageCreate!(h.ctx, say(h, "12", "spam"));
    await plugin.events!.messageCreate!(h.ctx, say(h, "12", "spam"));
    expect(helpTasks(h)).toHaveLength(0);
    expect(h.sent).toHaveLength(0);
    expect(h.typing).toHaveLength(0);
    expect(h.kv.has("rate:" + h.channel("help")!.id)).toBe(false);
  });

  it("stays silent when the member loses access after the question was queued", async () => {
    const h = harness();
    await plugin.events!.messageCreate!(h.ctx, say(h, "11", "question"));
    expect(helpTasks(h)).toHaveLength(1);
    await h.member("11")!.addRole("muted");
    await runHelp(h);
    expect(h.sent).toHaveLength(0);
    expect(h.typing).toHaveLength(0);
  });

  it("does not rate limit a redelivered event by its own claim", async () => {
    const h = harness();
    const m = say(h, "11", "question");
    await plugin.events!.messageCreate!(h.ctx, m);
    await plugin.events!.messageCreate!(h.ctx, m);
    expect(helpTasks(h)).toHaveLength(2);
    await runHelp(h, 0);
    await runHelp(h, 1);
    expect(h.sent).toHaveLength(1);
  });
});
