import type { Context, Message } from "@cicord/sdk";
import { createTestContext, callRoute, type TestContextOptions } from "@cicord/sdk/testing";
import { afterEach, expect, test, vi } from "vite-plus/test";
import schema from "../config.schema.json" with { type: "json" };
import plugin from "../src/index.ts";
import { open, quiet, publicRaid, close, reconcileRaid } from "../src/raid.ts";
import { sanction } from "../src/sanctions.ts";
import { linksIn } from "../src/rules.ts";
const setup = (
  config = {},
  features: string[] = [],
  media: Pick<TestContextOptions, "hashImage"> = {},
) =>
  createTestContext({
    ...media,
    schema,
    config,
    features,
    server: { ownerId: "staff" },
    channels: { a: { name: "A" }, b: { name: "B" }, c: { name: "C" } },
    roles: { quarantine: { name: "Quarantine" } },
    members: [
      { id: "user", joinedAt: new Date(0) },
      { id: "other", joinedAt: new Date(0) },
      { id: "staff" },
    ],
  });
afterEach(() => vi.useRealTimers());
test("duplicates span channels; compare actual messages and remove exactly the three matches", async () => {
  const t = setup(
    {
      mode: "enforce",
      quarantineRole: "quarantine",
      newAccounts: { restrict: [] },
      // The spec's acceptance case; the shipped defaults are 4 copies and message removal.
      duplicates: { count: 3, action: { type: "quarantine" } },
    },
    ["removeMessages", "directQuarantine"],
  );
  const m = t.member("user")!;
  const messages = new Map<string, Message>(),
    removed: string[] = [];
  for (const [index, key] of ["a", "b", "c"].entries()) {
    const channel = t.channel(key)!;
    const ch = { ...channel, message: async (id: string) => messages.get(id) };
    const msg: Message = {
      ...(await channel.send("fixture")),
      id: String(index + 1),
      author: m.user,
      member: m,
      channel: ch,
      content: "  SAME link https://example.org ",
      attachments: [],
      delete: async () => {
        removed.push(String(index + 1));
      },
    };
    messages.set(msg.id, msg);
  }
  const channels = [...messages.values()].map((m) => m.channel);
  const ctx: Context = {
    ...t.ctx,
    server: {
      ...t.ctx.server,
      channel: (ref) => channels.find((c) => c.id === (typeof ref === "string" ? ref : ref.id))!,
    },
  };
  for (const msg of messages.values()) await plugin.events!.messageCreate!(ctx, msg);
  expect(removed.sort()).toEqual(["1", "2", "3"]);
  expect(t.roleChanges).toMatchObject([{ member: "user", role: "quarantine", action: "add" }]);
  expect(JSON.stringify([...t.kv])).not.toContain("example.org");
});
test("monitor detects without writes to Discord, filters protected members, restricts staff blocklist", async () => {
  const t = setup({ links: { mode: "denylist", domains: ["unsafe.example"] } });
  for (const id of ["user", "other", "staff"]) {
    const m = t.member(id)!;
    await plugin.events!.messageCreate!(t.ctx, {
      ...(await t.channel("a")!.send("fixture")),
      author: m.user,
      member: m,
      channel: t.channel("a")!,
      id,
      content: "https://sub.unsafe.example",
      attachments: [],
    });
  }
  expect(t.published).toHaveLength(2);
  expect(t.deletedMessages).toEqual([]);
  expect(t.moderation).toEqual([]);
  expect(
    (
      await callRoute(plugin, t, "POST /blocklist", {
        viewer: "user",
        body: { kind: "domain", action: "add", value: "example.org" },
      })
    ).status,
  ).toBe(403);
  expect(linksIn("https://x.example@another.example/path")).toMatchObject([
    { host: "another.example" },
  ]);
  const other = await plugin.privacy!.export(t.ctx, "other");
  await plugin.privacy!.erase(t.ctx, "user");
  expect(await plugin.privacy!.export(t.ctx, "user")).toEqual({});
  expect(await plugin.privacy!.export(t.ctx, "other")).toEqual(other);
});
test("twenty simulated arrivals produce one monitor incident and quiet expiry", async () => {
  vi.useFakeTimers();
  const t = setup(),
    now = Date.now();
  for (let i = 0; i < 20; i++) {
    vi.setSystemTime(now + i * 1000);
    const m = t.addMember({ id: String(i + 100) });
    await plugin.events!.memberJoin!(t.ctx, m);
  }
  expect(t.published.filter((e) => e.topic === "raid")).toHaveLength(1);
  vi.setSystemTime(now + 17 * 60000);
  await quiet(t.ctx);
  expect(t.published.at(-1)?.payload).toMatchObject({ state: "ended" });
  expect(t.moderation).toEqual([]);
});
test("raid overlay uses a stable instance-local ID and releases only that overlay", async () => {
  const t = setup({ mode: "enforce", raid: { calmMinutes: 1 } }, ["raidOverlay"]);
  const applied: string[] = [],
    released: string[] = [];
  const ctx = {
    ...t.ctx,
    server: {
      ...t.ctx.server,
      overlays: {
        ...t.ctx.server.overlays,
        apply: async (p: { id: string }) => {
          applied.push(p.id);
        },
        remove: async (id: string) => {
          released.push(id);
        },
      },
    },
  };
  vi.useFakeTimers();
  const now = Date.now();
  await open(ctx, 20);
  await open(ctx, 40);
  // The deadline moved by less than a minute: no second overlay write (MOD-05).
  expect(applied).toEqual(["raid"]);
  vi.setSystemTime(now + 61000);
  await quiet(ctx);
  expect(applied).toEqual(["raid"]);
  expect(released).toEqual(["raid"]);
});

test("the re-encoded SDK media fixture triggers an image violation through the message handler", async () => {
  // The SDK media test hashes the 320px PNG and a 144px JPEG at quality 70.
  const original = "82673f3e3c60c327",
    jpeg = "82673f3e3c40c367";
  const observed: string[] = [];
  const t = setup({ images: { hashes: [original], threshold: 2 } }, ["images"], {
    hashImage: async (source) => {
      observed.push(typeof source === "string" ? source : source.id);
      return jpeg;
    },
  });
  const member = t.member("user")!,
    channel = t.channel("a")!;
  const attachment = t.attachment({
    name: "sample.jpg",
    data: new Uint8Array([0xff, 0xd8]),
    contentType: "image/jpeg",
  });
  const msg: Message = {
    ...(await channel.send("fixture")),
    id: "image",
    author: member.user,
    member,
    channel,
    content: "",
    attachments: [attachment],
  };
  await plugin.events!.messageCreate!(t.ctx, msg);
  expect(observed).toEqual([attachment.id]);
  expect(t.published[0]?.payload).toMatchObject({ rule: "images", action: "monitor" });
});

test("an uncertain provider response records the violation without a direct timeout", async () => {
  const t = setup(
    { mode: "enforce", links: { domains: ["blocked.example"], action: { type: "timeout" } } },
    ["sanctions", "directSanctions"],
  );
  const calls: string[] = [];
  const ctx: Context = {
    ...t.ctx,
    plugins: {
      ...t.ctx.plugins,
      has: () => true,
      call: async (_p, _m, _i, o) => {
        calls.push(o.idempotencyKey);
        throw new Error("timeout");
      },
    },
  };
  const member = t.member("user")!;
  const msg: Message = {
    ...(await t.channel("a")!.send("fixture")),
    id: "lost",
    author: member.user,
    member,
    channel: t.channel("a")!,
    content: "https://blocked.example",
    attachments: [],
  };
  await plugin.events!.messageCreate!(ctx, msg);
  await plugin.events!.messageCreate!(ctx, msg);
  expect(calls).toEqual(["guard:links:lost"]);
  expect(t.moderation).toEqual([]);
  expect(t.kv.get("violations:user")).toMatchObject([{ status: "needs_review" }]);
});

test("sanctions send a duration only for timeout and quarantine", async () => {
  const t = setup({}, ["sanctions"]);
  const ctx: Context = { ...t.ctx, plugins: { ...t.ctx.plugins, has: () => true } };
  const recorded = new Error("request recorded");
  const call = vi.spyOn(ctx.plugins, "call").mockRejectedValue(recorded);
  const member = t.member("user")!;
  for (const type of ["ban", "ban", "kick", "warn", "timeout", "quarantine"] as const) {
    const minutes = call.mock.calls.length === 0 ? 0 : 10;
    await expect(
      sanction(ctx, member, { type, minutes }, "review", "fixture-" + call.mock.calls.length),
    ).rejects.toBe(recorded);
  }
  expect(call.mock.calls.map(([, , input]) => input)).toEqual(
    ["ban", "ban", "kick", "warn", "timeout", "quarantine"].map((action) => ({
      userId: "user",
      action,
      reason: "review",
      ...(["timeout", "quarantine"].includes(action) ? { durationMinutes: 10 } : {}),
    })),
  );
});

test("a failed incident step and a failed lift retry without reopening a finished raid", async () => {
  const t = setup({ mode: "enforce", raid: { calmMinutes: 1 } }, ["raidOverlay", "pauseInvites"]);
  const grant = vi.fn().mockResolvedValue(undefined);
  const lift = vi
    .fn()
    .mockRejectedValueOnce(new Error("temporary failure"))
    .mockResolvedValue(undefined);
  const incident = vi.fn().mockRejectedValueOnce(new Error("pause")).mockResolvedValue(undefined);
  const ctx: Context = {
    ...t.ctx,
    server: {
      ...t.ctx.server,
      incident,
      overlays: { ...t.ctx.server.overlays, apply: grant, remove: lift },
    },
  };
  expect(await open(ctx, 20)).toBe("pending");
  const first = await ctx.kv.get<{ started: number; wake: string; pending: string[] }>("raid");
  expect(first!.pending).toEqual(["invites"]);
  await reconcileRaid(ctx, first!.started, first!.wake);
  expect((await publicRaid(ctx))?.phase).toBe("active");
  expect(grant).toHaveBeenCalledTimes(1);
  expect(incident).toHaveBeenCalledTimes(2);
  expect(await close(ctx)).toBe(false);
  const closing = await ctx.kv.get<{ started: number; wake: string; phase: string }>("raid");
  expect(closing!.phase).toBe("closing");
  await reconcileRaid(ctx, closing!.started, closing!.wake);
  expect(await publicRaid(ctx)).toBeNull();
  await reconcileRaid(ctx, first!.started, first!.wake);
  expect(lift).toHaveBeenCalledTimes(2);
  expect(grant).toHaveBeenCalledTimes(1);
});
test("the project's other Cicord bots are always exempt, even without a bot flag (P7)", async () => {
  const t = createTestContext({
    schema,
    config: { mode: "enforce", links: { mode: "denylist", domains: ["unsafe.example"] } },
    features: ["directSanctions", "removeMessages"],
    server: { ownerId: "staff", otherCicordBotIds: ["sibling"] },
    channels: { a: { name: "A" } },
    // A sibling Cicord bot seen without its bot flag (partial member data).
    members: [{ id: "sibling", joinedAt: new Date(0) }, { id: "user", joinedAt: new Date(0) }],
  });
  const post = async (id: string) => {
    const m = t.member(id)!;
    await plugin.events!.messageCreate!(t.ctx, {
      ...(await t.channel("a")!.send("fixture")),
      author: m.user,
      member: m,
      content: "see https://unsafe.example/x",
      attachments: [],
    });
  };
  expect(t.ctx.server.cicordBotIds).toContain("sibling");
  await post("sibling");
  expect(JSON.stringify([...t.kv])).not.toContain("sibling");
  await post("user");
  expect(JSON.stringify([...t.kv])).toContain("user");
  // The sanction path refuses them too, whatever led there.
  await sanction(t.ctx, t.member("sibling")!, { type: "kick" } as never, "guard links", "k1");
  await sanction(t.ctx, t.member("bot") ?? ({ id: "bot" } as never), { type: "ban" } as never, "x", "k2");
  expect(t.moderation.filter((m) => m.member === "sibling" || m.member === "bot")).toEqual([]);
});
