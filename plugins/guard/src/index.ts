import {
  command,
  definePlugin,
  sdkFeatures,
  subcommand,
  type RouteResponse,
  type Context,
  type Json,
} from "@cicord/sdk";
import { MONTH, object, rows, serial, staff, tr } from "./data.ts";
import { domain, exempt, inspect, refreshFeeds } from "./rules.ts";
import { record } from "./sanctions.ts";
import {
  ARRIVAL,
  JOIN,
  close,
  control,
  onJoin,
  open,
  publicRaid,
  quiet,
  reconcileRaid,
} from "./raid.ts";

const prefixes = [
  "history:",
  "violations:",
  "automod:",
  "selection:",
  "failed:",
  "lock:member:",
  JOIN,
  ARRIVAL,
];
async function memberData(ctx: Context, id: string, erase: boolean) {
  const data: Record<string, Json> = {};
  let erased = 0;
  for (const prefix of prefixes) {
    const key = prefix + id,
      value = await ctx.kv.get(key);
    if (value !== undefined) {
      data[prefix] = value;
      if (erase) {
        await ctx.kv.delete(key);
        erased++;
      }
    }
  }
  for (const row of await rows<{ stamp: number; ids: string[] }>(ctx, "selection:")) {
    if (!row.value.ids.includes(id)) continue;
    data.reviewed = true;
    if (erase) {
      await ctx.kv.set(
        row.key,
        { ...row.value, ids: row.value.ids.filter((v) => v !== id) },
        { ttlSeconds: 60 },
      );
      erased++;
    }
  }
  return { data, erased };
}
async function manage(ctx: Context, body: Json | undefined): Promise<RouteResponse> {
  const { kind, value, action } = object(body);
  if (
    typeof value !== "string" ||
    (kind !== "domain" && kind !== "hash") ||
    (action !== "add" && action !== "remove")
  )
    return { status: 400, body: { error: "invalid_input" } };
  const item = value.toLowerCase();
  if (!(kind === "hash" ? /^[a-f0-9]{16}$/.test(item) : domain(item)))
    return { status: 400, body: { error: "invalid_value" } };
  const key = kind === "hash" ? "hashes" : "domains",
    list = (await ctx.kv.get<string[]>(key)) ?? [];
  const values = new Set(list);
  if (action === "add") values.add(item);
  else values.delete(item);
  if (values.size > 500) return { status: 422, body: { error: "limit" } };
  await ctx.kv.set(key, [...values]);
  return { status: 200, body: { items: [...values] } };
}
const raidControl = (ctx: Context, i: import("@cicord/sdk").ComponentInteraction) =>
  serial(ctx, "raid", () => control(ctx, i));
export default definePlugin({
  onStart(ctx) {
    ctx.features.report(
      "duplicates",
      ctx.config.duplicates.enabled,
      ctx.config.duplicates.enabled ? undefined : "disabled by configuration",
    );
  },
  events: {
    async messageCreate(ctx, msg) {
      const member = msg.member ?? (await ctx.server.member(msg.author.id));
      if (!member || exempt(ctx, member, msg.channel.key ?? msg.channel.id)) return;
      await serial(ctx, "member:" + member.id, async () => {
        const match = await inspect(ctx, msg, member);
        if (match) await record(ctx, member, match.rule, msg.channel.id, match.refs, msg.id);
      });
    },
    memberJoin: (ctx, m) => onJoin(ctx, m, (rate) => serial(ctx, "raid", () => open(ctx, rate))),
    async automodAction(ctx, e) {
      const m = await ctx.server.member(e.userId);
      if (
        !m ||
        !e.channelId ||
        exempt(ctx, m, ctx.server.channel({ id: e.channelId }).key ?? e.channelId)
      )
        return;
      if (!["blockMessage", "block_message", "block", "1"].includes(String(e.action))) return;
      await serial(ctx, "member:" + m.id, async () => {
        const k = "automod:" + e.userId,
          now = Date.now(),
          c = ctx.config.automod;
        const list = ((await ctx.kv.get<number[]>(k)) ?? []).filter(
          (at) => now - at < c.seconds * 1000,
        );
        list.push(now);
        if (list.length >= c.count) {
          await record(ctx, m, "automod", e.channelId!, [], m.id + ":" + e.rule + ":" + now);
          await ctx.kv.delete(k);
        } else await ctx.kv.set(k, list, { ttlSeconds: c.seconds });
      });
    },
  },
  subscriptions: {
    "verification.failed": async (ctx, payload, meta) => {
      const id = object(payload).userId;
      if (typeof id !== "string") return;
      const seen = "seen:" + meta.id;
      if (await ctx.kv.get(seen)) return;
      // One signal per member per window so one person cannot simulate a join surge.
      await ctx.kv.set("failed:" + id, true, { ttlSeconds: ctx.config.raid.seconds });
      const count = (await rows(ctx, "failed:", ctx.config.raid.failedVerifications)).length;
      if (count >= ctx.config.raid.failedVerifications)
        await serial(ctx, "raid", () => open(ctx, 0));
      await ctx.kv.set(seen, true, { ttlSeconds: MONTH });
    },
  },
  tasks: {
    async reconcileRaid(ctx, payload, task) {
      const started = object(payload).started;
      if (typeof started !== "number" || !task?.id) throw new Error("invalid raid wakeup");
      await serial(ctx, "raid", () => reconcileRaid(ctx, started, task.id));
    },
  },
  schedules: {
    quiet: { cron: "* * * * *", run: (ctx) => serial(ctx, "raid", () => quiet(ctx)) },
    feeds: { cron: "17 */4 * * *", run: refreshFeeds },
  },
  ...(sdkFeatures?.contextMenus
    ? {
        contextMenus: {
          "Block image": {
            type: "message" as const,
            permissions: ["ManageMessages" as const],
            ephemeral: true,
            async run(
              ctx: Context,
              i: import("@cicord/sdk").Interaction & { target: import("@cicord/sdk").Message },
            ) {
              if (
                !staff(i.member) ||
                !ctx.features.enabled("images") ||
                !i.member?.canView(i.target.channel)
              ) {
                await i.reply(tr(ctx, "message.unavailable"));
                return;
              }
              const image = i.target.attachments.find((a) => a.contentType?.startsWith("image/"));
              if (!image) {
                await i.reply(tr(ctx, "message.chooseAMessageWithAnImage"));
                return;
              }
              const hash = await ctx.media.hash(image, { algo: "phash" });
              const result = await manage(ctx, { kind: "hash", action: "add", value: hash });
              const ok = object(result as Json).status === 200;
              await i.reply(
                ok ? tr(ctx, "message.imageAddedToTheBlocklist") : tr(ctx, "message.blocklistFull"),
              );
            },
          },
        },
      }
    : {}),
  commands: {
    lockdown: command({
      description: "Manage raid measures",
      permissions: ["ManageServer"],
      ephemeral: true,
      subcommands: {
        on: subcommand({
          description: "Start raid measures",
          async run(ctx, i) {
            if (!staff(i.member)) {
              await i.reply(tr(ctx, "message.unavailable"));
              return;
            }
            const phase = await serial(ctx, "raid", () => open(ctx, 0, true));
            await i.reply(
              tr(
                ctx,
                phase === "active"
                  ? "message.lockdownActive"
                  : phase === "refused"
                    ? "message.lockdownRefused"
                    : phase === "closing"
                      ? "status.raidClosing"
                      : "status.raidPending",
              ),
            );
          },
        }),
        off: subcommand({
          description: "Lift raid measures",
          async run(ctx, i) {
            if (!staff(i.member)) {
              await i.reply(tr(ctx, "message.unavailable"));
              return;
            }
            const closed = await serial(ctx, "raid", () => close(ctx));
            await i.reply(tr(ctx, closed ? "message.requestProcessed" : "status.raidClosing"));
          },
        }),
      },
    }),
  },
  components: {
    lift: raidControl,
    extend: raidControl,
    review: raidControl,
    select: raidControl,
    confirm: raidControl,
  },
  routes: {
    "GET /violations": {
      access: "moderator",
      async handler(ctx, r): Promise<RouteResponse> {
        if (!staff(r.viewer?.member)) return { status: 403 };
        const p = await ctx.kv.list({ prefix: "violations:", limit: 50, cursor: r.query.cursor });
        return {
          items: p.items.map((x) => ({ userId: x.key.slice(11), violations: x.value })),
          cursor: p.cursor ?? null,
        };
      },
    },
    "GET /raids": {
      access: "moderator",
      async handler(ctx, r): Promise<RouteResponse> {
        if (!staff(r.viewer?.member)) return { status: 403 };
        return {
          active: await publicRaid(ctx),
          history: (await rows(ctx, "raidHistory:", 100)).map((r) => r.value),
        };
      },
    },
    "GET /blocklist": {
      access: "moderator",
      async handler(ctx, r): Promise<RouteResponse> {
        if (!staff(r.viewer?.member)) return { status: 403 };
        return {
          domains: (await ctx.kv.get("domains")) ?? [],
          hashes: (await ctx.kv.get("hashes")) ?? [],
        };
      },
    },
    "POST /blocklist": {
      access: "moderator",
      async handler(ctx, r): Promise<RouteResponse> {
        if (!staff(r.viewer?.member)) return { status: 403 };
        return manage(ctx, r.body);
      },
    },
  },
  privacy: {
    async export(ctx, id) {
      return (await memberData(ctx, id, false)).data;
    },
    async erase(ctx, id) {
      return { erased: (await memberData(ctx, id, true)).erased };
    },
  },
});
