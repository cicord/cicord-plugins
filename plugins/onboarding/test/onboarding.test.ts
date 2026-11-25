import { callRoute, createTestContext, runCommand } from "@cicord/sdk/testing";
import { describe, expect, test } from "vite-plus/test";
import schema from "../config.schema.json" with { type: "json" };
import plugin from "../src/index.ts";

const config = {
  title: "Welcome!",
  intro: "Intro",
  steps: [
    {
      id: "games",
      title: "What do you play?",
      multiple: true,
      options: [
        { role: "minecraft", emoji: "⛏️" },
        { role: "valorant", label: "Valo" },
      ],
    },
    {
      id: "platform",
      title: "Platform",
      required: true,
      options: [{ role: "pc" }, { role: "console" }],
    },
    { id: "notifications", title: "Notifications", options: [{ role: "ping-events" }] },
  ],
  completedRole: "member",
  successMessage: "All done!",
  linkMessage: "Pick your roles:",
  buttonLabel: "Pick",
};

const grants = ["discord.roles.assign", "storage.kv", "portal.routes", "portal.links"];

function setup(memberRoles: string[] = []) {
  return createTestContext({
    config,
    schema, // applies the config defaults like the runtime (e.g. steps[].multiple)
    grants,
    plugin: { name: "onboarding", instance: "onboarding" },
    roles: {
      admin: { name: "Admin", color: "#e74c3c" },
      member: { name: "Member", color: "#3498db" },
      minecraft: { name: "Minecraft", color: "#5b8731" },
      valorant: { name: "Valorant", color: "#ff4655" },
      pc: { name: "PC" },
      console: { name: "Console" },
      "ping-events": { name: "Notifications" },
    },
    members: [{ id: "1", username: "alice", roles: memberRoles }],
  });
}

describe("GET /steps", () => {
  test("resolves options and current selections", async () => {
    const t = setup(["valorant", "pc", "admin"]);
    const res = await callRoute(plugin, t, "GET /steps", { viewer: "1" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      title: "Welcome!",
      completed: false,
      completedAt: null,
      completedRole: { key: "member", name: "Member", color: "#3498db" },
      steps: [
        {
          id: "games",
          multiple: true,
          required: false,
          description: "",
          options: [
            {
              role: "minecraft",
              label: "Minecraft",
              emoji: "⛏️",
              name: "Minecraft",
              color: "#5b8731",
            },
            { role: "valorant", label: "Valo", emoji: "", name: "Valorant", color: "#ff4655" },
          ],
          selected: ["valorant"],
        },
        { id: "platform", multiple: false, required: true, selected: ["pc"] },
        { id: "notifications", selected: [] },
      ],
    });
  });

  test("requires a member", async () => {
    expect((await callRoute(plugin, setup(), "GET /steps")).status).toBe(401);
    expect((await callRoute(plugin, setup(), "GET /steps", { viewer: "999" })).status).toBe(403);
  });
});

describe("POST /complete", () => {
  test("adds and removes only configured roles, stores completion", async () => {
    const t = setup(["valorant", "console", "admin"]);
    const res = await callRoute(plugin, t, "POST /complete", {
      viewer: "1",
      body: { answers: { games: ["minecraft"], platform: ["pc"] } },
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      completed: true,
      added: ["minecraft", "pc", "member"],
      removed: ["valorant", "console"],
      message: "All done!",
    });
    const roles = (res.body as { roles: { key: string }[] }).roles.map((r) => r.key).toSorted();
    expect(roles).toEqual(["admin", "member", "minecraft", "pc"]);
    // Live member agrees; admin (not in config) untouched.
    const member = t.member("1");
    expect(member?.roles.map((r) => r.key).toSorted()).toEqual(roles);
    expect(t.kv.get("completed:1")).toMatchObject({
      answers: { games: ["minecraft"], platform: ["pc"], notifications: [] },
    });
    expect(t.kv.get("stats:completed")).toBe(1);

    const again = await callRoute(plugin, t, "GET /steps", { viewer: "1" });
    expect(again.body).toMatchObject({ completed: true });
    await callRoute(plugin, t, "POST /complete", {
      viewer: "1",
      body: { answers: { platform: ["pc"] } },
    });
    expect(t.kv.get("stats:completed")).toBe(1);
  });

  test("rejects malformed bodies with 400", async () => {
    const res = await callRoute(plugin, setup(), "POST /complete", {
      viewer: "1",
      body: { nope: true },
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: { code: "invalid" } });
  });

  test("validates answers against the config with 422 + diagnostics", async () => {
    const t = setup();
    const res = await callRoute(plugin, t, "POST /complete", {
      viewer: "1",
      body: { answers: { games: ["admin"], platform: ["pc", "console"], ghost: [] } },
    });
    expect(res.status).toBe(422);
    const error = (
      res.body as { error: { code: string; diagnostics: { path: string; message: string }[] } }
    ).error;
    expect(error.code).toBe("invalid");
    expect(error.diagnostics.map((d) => d.path).toSorted()).toEqual([
      "/answers/games",
      "/answers/ghost",
      "/answers/platform",
    ]);
    expect(t.roleChanges).toEqual([]);
    expect(t.kv.size).toBe(0);
  });

  test("required steps must be answered", async () => {
    const res = await callRoute(plugin, setup(), "POST /complete", {
      viewer: "1",
      body: { answers: {} },
    });
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toContain('step \\"platform\\" is required');
  });
});

describe("/onboarding command", () => {
  test("replies with an ephemeral link button to the portal", async () => {
    const t = setup();
    const result = await runCommand(plugin, t, "onboarding", { user: "1" });
    expect(t.links).toEqual([
      {
        path: "/onboarding",
        member: "1",
        url: "https://portal.test/onboarding?cicord_token=test-1",
      },
    ]);
    expect(result.replies).toEqual([
      {
        ephemeral: true,
        content: "Pick your roles:",
        components: [
          {
            type: "row",
            components: [
              {
                type: "link",
                label: "Pick",
                emoji: "✨",
                url: "https://portal.test/onboarding?cicord_token=test-1",
              },
            ],
          },
        ],
      },
    ]);
  });
});
