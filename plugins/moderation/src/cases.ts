import {
  command,
  subcommand,
  type Context,
  type Json,
  type RouteRequest,
  type RouteResponse,
} from "@cicord/sdk";
import { type Case, readCase, indexCase, who, warnPrefix } from "./moderation.ts";

const numberOption = {
  type: "integer",
  description: "Case number",
  required: true,
  minValue: 1,
} as const;
function describe(c: Case) {
  return `#${c.number} · ${c.action} · ${c.status ?? "active"} — ${c.reason || "No reason"}`;
}
export const caseCommand = command({
  description: "Read or update moderation cases",
  ephemeral: true,
  permissions: ["ModerateMembers"],
  subcommands: {
    view: subcommand({
      description: "View a case",
      options: { number: numberOption },
      async run(ctx, it) {
        const c = await readCase(ctx, it.options.number);
        if (it.member?.access !== "admin" && it.member?.access !== "moderator") {
          await it.reply("Staff access required.");
          return;
        }
        await it.reply(c ? describe(c) : "Case not found.");
      },
    }),
    reason: subcommand({
      description: "Correct the reason for a case",
      options: {
        number: numberOption,
        text: { type: "string", description: "Corrected reason", required: true },
      },
      async run(ctx, it) {
        if (it.member?.access !== "moderator" && it.member?.access !== "admin") {
          await it.reply("Staff access required.");
          return;
        }
        const c = await readCase(ctx, it.options.number);
        if (!c) {
          await it.reply("Case not found.");
          return;
        }
        c.reason = it.options.text.slice(0, 1500);
        await ctx.kv.set(`case:${c.number}`, c);
        if (c.action !== "note")
          await ctx.events.publish("caseUpdated", {
            number: c.number,
            changes: ["reason"],
            by: it.user.id,
          });
        await it.reply(describe(c));
      },
    }),
    void: subcommand({
      description: "Void a case while retaining its history",
      options: { number: numberOption },
      async run(ctx, it) {
        if (it.member?.access !== "admin") {
          await it.reply("Administrator access required.");
          return;
        }
        const c = await readCase(ctx, it.options.number);
        if (!c) {
          await it.reply("Case not found.");
          return;
        }
        if (c.status !== "void") {
          if (c.action === "warn" && c.member)
            await ctx.kv.delete(warnPrefix(c.member.id) + String(c.number).padStart(8, "0"));
          await ctx.kv.set(`case:${c.number}`, { ...c, status: "void" });
          if (c.action !== "note")
            await ctx.events.publish("caseUpdated", {
              number: c.number,
              changes: ["status"],
              by: it.user.id,
            });
        }
        await it.reply(`Case #${c.number} voided.`);
      },
    }),
  },
});
export const noteCommand = command({
  description: "Record a private staff note",
  ephemeral: true,
  permissions: ["ModerateMembers"],
  options: {
    member: { type: "user", description: "Member", required: true },
    text: { type: "string", description: "Private note", required: true },
  },
  async run(ctx, it) {
    if (it.member?.access !== "moderator" && it.member?.access !== "admin") {
      await it.reply("Staff access required.");
      return;
    }
    const number = await ctx.kv.increment("cases");
    const c: Case = {
      number,
      action: "note",
      at: new Date().toISOString(),
      reason: it.options.text.slice(0, 1500),
      member: who(it.options.member),
      moderator: who(it.user),
      status: "active",
      source: { type: "command" },
    };
    await ctx.kv.set(`case:${number}`, c);
    await indexCase(ctx, c);
    await it.reply(`Private note #${number} recorded.`);
  },
});
async function history(ctx: Context, user: string, staff: boolean, limit: number) {
  const page = await ctx.kv.list<number>({ prefix: `case-user:${user}:`, limit });
  const out: Case[] = [];
  for (const { value } of page.items) {
    const c = await readCase(ctx, value);
    if (c && (staff || c.action !== "note")) out.push(c);
  }
  return out;
}
export const historyCommand = command({
  description: "Show recent cases for a member",
  ephemeral: true,
  permissions: ["ModerateMembers"],
  options: { member: { type: "user", required: true, description: "Member" } },
  async run(ctx, it) {
    const staff = it.member?.access === "moderator" || it.member?.access === "admin";
    if (!staff && it.options.member.id !== it.user.id) {
      await it.reply("Staff access required.");
      return;
    }
    const items = await history(ctx, it.options.member.id, staff, 10);
    await it.reply(
      items.length ? items.map(describe).join("\n").slice(0, 1950) : "No recent cases.",
    );
  },
});

export async function memberHistory(ctx: Context, req: RouteRequest): Promise<RouteResponse> {
  const user = req.params["id"] ?? "";
  const staff =
    req.viewer?.member?.access === "moderator" || req.viewer?.member?.access === "admin";
  if (!staff && (!req.viewer || req.viewer.user.id !== user))
    return { status: 403, body: { error: "forbidden" } };
  return { status: 200, body: { items: await history(ctx, user, staff, 50) } };
}

export async function listCases(ctx: Context, req: RouteRequest): Promise<RouteResponse> {
  const page = await ctx.kv.list<Case>({
    prefix: "case:",
    limit: 50,
    ...(req.query["cursor"] ? { cursor: req.query["cursor"] } : {}),
  });
  const items = page.items
    .map(({ value: c }) => c)
    .filter(
      (c) =>
        (!req.query["status"] || (c.status ?? "active") === req.query["status"]) &&
        (!req.query["action"] || c.action === req.query["action"]) &&
        (!req.query["moderator"] || c.moderator?.id === req.query["moderator"]),
    );
  return { status: 200, body: { items, next: page.cursor ?? null } as unknown as Json };
}

export async function migrateCases(ctx: Context) {
  if (((await ctx.kv.get<number>("meta:schema")) ?? 1) >= 2) return;
  const cursor = await ctx.kv.get<string>("meta:cases-cursor");
  const page = await ctx.kv.list<Case>({
    prefix: "case:",
    limit: 25,
    ...(cursor ? { cursor } : {}),
  });
  for (const { key, value: c } of page.items) {
    // Preserve fields of already migrated and newly-created records.
    if (!c.status || !c.source) {
      c.status ??= "active";
      c.source ??= { type: c.moderator ? "command" : "escalation" };
      await ctx.kv.set(key, c);
    }
    await indexCase(ctx, c);
  }
  if (page.cursor) {
    await ctx.kv.set("meta:cases-cursor", page.cursor);
    await ctx.schedule.after(100, "migrateCases");
  } else {
    await ctx.kv.set("meta:schema", 2);
    await ctx.kv.delete("meta:cases-cursor");
  }
}
