import type { Message, MessagePayload, SelectMenu } from "@cicord/sdk";
import { createTestContext, runCommand, runComponent } from "@cicord/sdk/testing";
import { describe, expect, test } from "vite-plus/test";
import schema from "../config.schema.json" with { type: "json" };
import plugin from "../src/index.ts";
import { apiEmoji, displayEmoji, normalizeEmoji } from "../src/panels.ts";

const grants = [
  "discord.messages.send",
  "discord.messages.read",
  "discord.channels.read",
  "discord.roles.assign",
  "discord.members.read",
  "discord.reactions.manage",
  "storage.kv",
];

const panels = [
  {
    name: "colors",
    channel: "roles",
    title: "Colors",
    mode: "single",
    options: [
      { role: "red", emoji: "🔴" },
      { role: "blue", label: "Blue team", emoji: "<:blue:123456789012345678>" },
    ],
  },
  {
    name: "pings",
    channel: "roles",
    style: "select",
    requiredRole: "member",
    options: [
      { role: "events", description: "Game nights" },
      { role: "news", description: "Server news" },
    ],
  },
  {
    name: "games",
    channel: "roles",
    style: "reactions",
    options: [
      { role: "chess", emoji: "♟️" },
      { role: "go", emoji: "<a:go:223456789012345678>" },
      { role: "news" },
    ],
  },
];

function setup(config: Record<string, unknown> = {}) {
  return createTestContext({
    schema,
    config: { panels, ...config },
    grants,
    plugin: { name: "reaction-roles" },
    roles: {
      red: { name: "Red" },
      blue: { name: "Blue" },
      events: { name: "Events" },
      news: { name: "News" },
      chess: { name: "Chess" },
      go: { name: "Go" },
      member: { name: "Member" },
    },
    channels: { roles: { name: "roles" }, general: { name: "general" } },
    members: [
      { id: "1", username: "alice", roles: ["member"] },
      { id: "2", username: "bob" },
    ],
  });
}

type Harness = ReturnType<typeof setup>;

const panelMessage = (t: Harness, title: string) => {
  const s = t.sent.find((m) => (m.message as MessagePayload).embeds?.[0]?.title === title);
  if (!s) throw new Error(`panel ${title} not posted`);
  return { message: t.message(s.id) as Message, payload: s.message as MessagePayload };
};

const roleKeys = (t: Harness, id: string) => t.member(id)!.roles.map((r) => r.key);

describe("panels", () => {
  test("onStart posts every panel once, then leaves unchanged panels alone", async () => {
    const t = setup();
    await plugin.onStart!(t.ctx);
    expect(t.sent).toHaveLength(3);
    const colors = panelMessage(t, "Colors").payload;
    expect(colors.components?.[0]?.components).toEqual([
      { type: "button", id: "rr:colors:role-red", label: "Red", style: "secondary", emoji: "🔴" },
      {
        type: "button",
        id: "rr:colors:role-blue",
        label: "Blue team",
        style: "secondary",
        emoji: "blue:123456789012345678",
      },
    ]);
    expect(colors.embeds?.[0]?.footer?.text).toContain("Pick one role.");
    expect(colors.allowedMentions).toEqual({ users: false, roles: false, everyone: false });

    const pings = panelMessage(t, "Pick your roles").payload;
    const select = pings.components?.[0]?.components[0] as SelectMenu;
    expect(select).toMatchObject({ type: "select", id: "rrs:pings", minValues: 0, maxValues: 2 });
    expect(select.options.map((o) => o.value)).toEqual(["role-events", "role-news"]);
    expect(pings.embeds?.[0]?.footer?.text).toContain("Requires the Member role.");

    // Reaction panel: options without an emoji are left out; the bot adds the emojis.
    const games = t.sent[2]!;
    expect((games.message as MessagePayload).embeds?.[0]?.description).toBe(
      "♟️ <@&role-chess>\n<a:go:223456789012345678> <@&role-go>",
    );
    expect(t.reactions).toEqual([
      { message: games.id, emoji: "♟️" },
      { message: games.id, emoji: "a:go:223456789012345678" },
    ]);
    expect(t.logs.find((l) => l.message.includes("left out"))?.fields).toEqual({
      panel: "games",
      roles: ["News (no emoji)"],
    });

    await plugin.onStart!(t.ctx);
    expect(t.sent).toHaveLength(3);
    expect(t.edits).toHaveLength(0);
  });

  test("a changed panel is edited in place, a deleted or moved one is posted again", async () => {
    const t = setup();
    await plugin.onStart!(t.ctx);
    const first = panelMessage(t, "Colors").message;

    // A config change (new revision): same KV and history, edited config.
    (t.ctx.config as { panels: unknown[] }).panels[0] = {
      ...(t.ctx.config.panels[0] as object),
      title: "Colours",
    };
    const r = await runCommand(plugin, t, "role-panel", {
      user: "1",
      options: { panel: "colors" },
    });
    expect(r.replies).toEqual(["**colors**: updated in <#channel-roles>."]);
    expect(t.edits).toHaveLength(1);
    expect(t.edits[0]!.id).toBe(first.id);
    expect((t.edits[0]!.message as MessagePayload).embeds?.[0]?.title).toBe("Colours");

    // new_message: a second message, the old one stays (the bot cannot delete it).
    const again = await runCommand(plugin, t, "role-panel", {
      user: "1",
      options: { panel: "colors", new_message: true },
    });
    expect(again.replies[0]).toContain("posted again");
    expect(t.sent).toHaveLength(4);

    // Moved to another channel.
    (t.ctx.config as { panels: unknown[] }).panels[0] = {
      ...(t.ctx.config.panels[0] as object),
      channel: "general",
    };
    const moved = await runCommand(plugin, t, "role-panel", {
      user: "1",
      options: { panel: "colors" },
    });
    expect(moved.replies[0]).toBe(
      "**colors**: posted in its new channel <#channel-general>. Delete the old message by hand.",
    );
    expect(t.sent.at(-1)!.to).toBe("general");
  });

  test("/role-panel without panels or with an unknown name explains it", async () => {
    const t = setup({ panels: [] });
    const r = await runCommand(plugin, t, "role-panel", { user: "1" });
    expect(r.replies[0]).toContain("No panels are configured yet");
    const u = await runCommand(plugin, setup(), "role-panel", {
      user: "1",
      options: { panel: "nope" },
    });
    expect(u.replies[0]).toBe("No panel named `nope`. Panels: `colors`, `pings`, `games`.");
    expect(plugin.commands!["role-panel"]!.permissions).toEqual(["ManageRoles"]);
  });

  test("syncOnStart: false posts nothing at start", async () => {
    const t = setup({ syncOnStart: false });
    await plugin.onStart!(t.ctx);
    expect(t.sent).toHaveLength(0);
  });
});

describe("buttons", () => {
  test("toggle a role; single mode swaps the other role of the panel", async () => {
    const t = setup();
    await plugin.onStart!(t.ctx);
    const { message } = panelMessage(t, "Colors");
    const click = (id: string) => runComponent(plugin, t, id, { user: "2", message });

    let r = await click("rr:colors:role-red");
    expect(r.updates).toEqual([]); // the shared panel message is never edited by a click
    expect(r.replies[0]).toMatchObject({ content: "Added <@&role-red>.", ephemeral: true });
    expect(roleKeys(t, "2")).toEqual(["red"]);

    r = await click("rr:colors:role-blue");
    expect((r.replies[0] as { content: string }).content).toBe(
      "Added <@&role-blue>.\nRemoved <@&role-red>.",
    );
    expect(roleKeys(t, "2")).toEqual(["blue"]);

    r = await click("rr:colors:role-blue");
    expect((r.replies[0] as { content: string }).content).toBe("Removed <@&role-blue>.");
    expect(roleKeys(t, "2")).toEqual([]);
    expect(t.roleChanges.every((c) => c.reason === "reaction-roles: panel colors")).toBe(true);
  });

  test("refuses roles that are not options of the configured panel", async () => {
    const t = setup();
    const r = await runComponent(plugin, t, "rr:colors:role-member", { user: "2" });
    expect((r.replies[0] as { content: string }).content).toBe(
      "This role is no longer offered by the panel.",
    );
    const gone = await runComponent(plugin, t, "rr:old:role-red", { user: "2" });
    expect((gone.replies[0] as { content: string }).content).toBe(
      "This panel is no longer available.",
    );
    expect(t.roleChanges).toEqual([]);
  });

  test("explains the role hierarchy when Discord refuses the change", async () => {
    const t = setup();
    await t.member("2")!.addRole("blue"); // the current color, kept when the swap fails
    t.member("2")!.addRole = async () => {
      throw new Error(
        "discord AddMemberRole: discord: missing permissions (HTTP 403 50013: Missing Permissions)",
      );
    };
    const r = await runComponent(plugin, t, "rr:colors:role-red", { user: "2" });
    const text = (r.replies[0] as { content: string }).content;
    expect(text).toContain("I can't change the **Red** role: my highest role must be above it");
    expect(t.logs.some((l) => l.level === "warn" && l.message.includes("role change failed"))).toBe(
      true,
    );
    expect(roleKeys(t, "2")).toEqual(["blue"]);
  });
});

describe("select menu", () => {
  test("the member's panel roles become the selection; the required role is enforced", async () => {
    const t = setup();
    const pick = (user: string, values: string[]) =>
      runComponent(plugin, t, "rrs:pings", { user, values });

    const refused = await pick("2", ["role-events"]);
    expect((refused.replies[0] as { content: string }).content).toBe(
      "You need the **Member** role to use this panel.",
    );

    let r = await pick("1", ["role-events", "role-news", "role-red"]);
    expect((r.replies[0] as { content: string }).content).toBe(
      "Added <@&role-events>.\nAdded <@&role-news>.",
    );
    expect(roleKeys(t, "1")).toEqual(["events", "news", "member"]);
    r = await pick("1", ["role-news"]);
    expect((r.replies[0] as { content: string }).content).toBe("Removed <@&role-events>.");
    r = await pick("1", ["role-news"]);
    expect((r.replies[0] as { content: string }).content).toContain("Nothing changed");
    r = await pick("1", []);
    expect(roleKeys(t, "1")).toEqual(["member"]);
  });
});

describe("reactions", () => {
  test("reacting gives the role, removing the reaction takes it back", async () => {
    const t = setup();
    await plugin.onStart!(t.ctx);
    const games = t.message(t.sent[2]!.id)!;
    const user = t.member("2")!.user;
    await plugin.events!.reactionAdd!(t.ctx, { message: games, user, emoji: "♟" }); // no FE0F
    expect(roleKeys(t, "2")).toEqual(["chess"]);
    await plugin.events!.reactionAdd!(t.ctx, {
      message: games,
      user,
      emoji: "go:223456789012345678",
    });
    expect(roleKeys(t, "2")).toEqual(["chess", "go"]);
    await plugin.events!.reactionRemove!(t.ctx, { message: games, user, emoji: "♟️" });
    expect(roleKeys(t, "2")).toEqual(["go"]);

    // Other messages, other emojis and the bot's own reactions are ignored.
    const other = await t.ctx.server.channel("general").send("hi");
    await plugin.events!.reactionAdd!(t.ctx, { message: other, user, emoji: "♟️" });
    await plugin.events!.reactionAdd!(t.ctx, { message: games, user, emoji: "🍕" });
    await plugin.events!.reactionAdd!(t.ctx, {
      message: games,
      user: t.ctx.bot.user,
      emoji: "♟️",
    });
    expect(roleKeys(t, "2")).toEqual(["go"]);
    expect(t.roleChanges).toHaveLength(3);
  });
});

test("a reaction panel offers at most 20 options (Discord's reaction limit)", async () => {
  const roles = Object.fromEntries(
    Array.from({ length: 22 }, (_, i) => [`r${i}`, { name: `R${i}` }]),
  );
  const t = createTestContext({
    schema,
    config: {
      panels: [
        {
          name: "big",
          channel: "roles",
          style: "reactions",
          options: Array.from({ length: 22 }, (_, i) => ({ role: `r${i}`, emoji: `e${i}` })),
        },
      ],
    },
    grants,
    roles,
    channels: { roles: { name: "roles" } },
  });
  const r = await runCommand(plugin, t, "role-panel", { user: "1" });
  expect(t.reactions).toHaveLength(20);
  expect(r.replies[0]).toBe(
    "**big**: posted in <#channel-roles>. Left out: R20 (over Discord's 20-reaction limit), R21 (over Discord's 20-reaction limit).",
  );
});

test("emoji normalization", () => {
  expect(normalizeEmoji("<:blue:123456789012345678>")).toBe("blue:123456789012345678");
  expect(normalizeEmoji("<a:go:123456789012345678>")).toBe("go:123456789012345678");
  expect(normalizeEmoji("♟️")).toBe("♟");
  expect(displayEmoji("go:123456789012345678")).toBe("<:go:123456789012345678>");
  expect(apiEmoji("<a:go:123456789012345678>")).toBe("a:go:123456789012345678");
});
