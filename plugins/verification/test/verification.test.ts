import { createTestContext, callRoute } from "@cicord/sdk/testing";
import { describe, test, expect } from "vite-plus/test";
import schema from "../config.schema.json" with { type: "json" };
import plugin from "../src/index.ts";

const youngId = (((BigInt(Date.now() - 86400000) - 1420070400000n) << 22n) + 1n).toString();
const otherId = "10000000000000001";
const base = {
  schema,
  roles: { verified: { name: "Verified" } },
  channels: { verify: { name: "Verify" } },
  server: { ownerId: "99" },
  members: [
    { id: youngId, avatarUrl: "https://example.invalid/avatar.png" },
    { id: otherId },
    { id: "99" },
  ],
};
describe("verified membership", () => {
  test("bound challenge places a young account in review; only staff can approve", async () => {
    const t = createTestContext({ ...base, config: { method: "button" } });
    const get = await callRoute(plugin, t, "GET /challenge", { viewer: youngId });
    const { id } = get.body as { id: string };
    expect(
      (await callRoute(plugin, t, "POST /challenge", { viewer: otherId, body: { id } })).status,
    ).toBe(422);
    expect(
      (await callRoute(plugin, t, "POST /challenge", { viewer: youngId, body: { id } })).body,
    ).toMatchObject({ state: "hold" });
    expect(t.roleChanges).toHaveLength(0);
    expect((await callRoute(plugin, t, "GET /queue", { viewer: youngId })).status).toBe(403);
    expect((await callRoute(plugin, t, "GET /queue", { viewer: "99" })).body).toMatchObject({
      items: [{ userId: youngId }],
    });
    expect(
      (
        await callRoute(plugin, t, "POST /queue/" + youngId, {
          viewer: "99",
          body: { decision: "approve" },
        })
      ).body,
    ).toMatchObject({ verified: true });
    expect(t.roleChanges).toHaveLength(1);
    expect(t.published.filter((e) => e.topic === "passed")).toHaveLength(1);
  });
  test.each(["turnstile", "hcaptcha"] as const)(
    "consumes %s challenges once and keeps tokens out of KV",
    async (method) => {
      const token = "simulated-single-use-response";
      let traversals = 0;
      const t = createTestContext({
        ...base,
        config: {
          method,
          minAccountAgeDays: 0,
          turnstileSiteKey: "public",
          hcaptchaSiteKey: "public",
        },
        features: ["captcha"],
        secrets: [method === "turnstile" ? "TURNSTILE_SECRET" : "HCAPTCHA_SECRET"],
        fetch: (_url, init) => ({
          body: { success: init?.form?.response === token && ++traversals === 1 },
        }),
      });
      async function attempt(response: string, id: string) {
        return callRoute(plugin, t, "POST /challenge", {
          viewer: youngId,
          body: { id, token: response },
        });
      }
      const get = async () =>
        ((await callRoute(plugin, t, "GET /challenge", { viewer: youngId })).body as { id: string })
          .id;
      expect((await attempt("invalid", await get())).body).toEqual({ error: "challenge_failed" });
      const id = await get();
      expect((await attempt(token, id)).body).toEqual({ verified: true });
      expect((await attempt(token, id)).status).toBe(409);
      // A role is authoritative for access. A fresh member cannot reuse the provider proof.
      const next = (await callRoute(plugin, t, "GET /challenge", { viewer: otherId })).body as {
        id: string;
      };
      expect(
        (
          await callRoute(plugin, t, "POST /challenge", {
            viewer: otherId,
            body: { id: next.id, token },
          })
        ).status,
      ).toBe(422);
      expect(traversals).toBe(2);
      expect(JSON.stringify([...t.kv])).not.toContain(token);
      const before = await plugin.privacy!.export(t.ctx, otherId);
      await plugin.privacy!.erase(t.ctx, youngId);
      expect(await plugin.privacy!.export(t.ctx, youngId)).toEqual({});
      expect(await plugin.privacy!.export(t.ctx, otherId)).toEqual(before);
    },
  );
  test("missing optional secret degrades to a local method", async () => {
    const t = createTestContext({
      ...base,
      config: { method: "turnstile", turnstileSiteKey: "public" },
      features: ["captcha"],
    });
    await plugin.onStart!(t.ctx);
    expect(t.logs.some((x) => x.level === "warn")).toBe(true);
    expect((await callRoute(plugin, t, "GET /challenge", { viewer: youngId })).body).toMatchObject({
      method: "button",
    });
    expect(t.requests).toEqual([]);
  });
});

test("a post-kick recovery link is bound to its subject, case and expiry", async () => {
  const t = createTestContext({
    ...base,
    config: { method: "button", youngAccount: "kick" },
    features: ["dm", "directKick"],
  });
  const challenge = (await callRoute(plugin, t, "GET /challenge", { viewer: youngId })).body as {
    id: string;
  };
  expect(
    (await callRoute(plugin, t, "POST /challenge", { viewer: youngId, body: { id: challenge.id } }))
      .body,
  ).toEqual({ verified: false });
  expect(t.moderation).toMatchObject([{ action: "kick", member: youngId }]);
  const scoped = t.links.find((link) => link.scope)!;
  t.removeMember(youngId);
  const route = "GET /return/" + scoped.scope!.id;
  expect(
    (await callRoute(plugin, t, route, { viewer: youngId, scopedLink: scoped.url })).body,
  ).toMatchObject({ result: "kicked" });
  expect(
    (await callRoute(plugin, t, route, { viewer: otherId, scopedLink: scoped.url })).status,
  ).toBe(403);
  await plugin.privacy!.erase(t.ctx, youngId);
  expect(
    (await callRoute(plugin, t, route, { viewer: youngId, scopedLink: scoped.url })).status,
  ).toBe(403);
});
