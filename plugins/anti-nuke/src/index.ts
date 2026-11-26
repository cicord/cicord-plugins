import {
  command,
  definePlugin,
  subcommand,
  type RouteResponse,
  type Context,
  type CommandInteraction,
} from "@cicord/sdk";
import { MONTH, object, serial, staff, tr } from "./data.ts";
import { audit, memberData, settle, structure } from "./monitor.ts";
async function diagnostics(ctx: Context) {
  const warnings: string[] = [];
  const bot = await ctx.server.member(ctx.bot.user.id);
  if (!bot?.permissions?.includes("ViewAuditLog"))
    warnings.push(tr(ctx, "message.auditLogPermissionMissingOrUnavailable"));
  const protection = await ctx.server.protection?.();
  if (protection) {
    if (!protection.selfHeal) warnings.push(tr(ctx, "message.automaticRestorationIsDisabled"));
    if (!protection.deletionProtection)
      warnings.push(tr(ctx, "message.deletionProtectionIsDisabled"));
    if (protection.paused) warnings.push(tr(ctx, "message.reconciliationIsPaused"));
    if (protection.unmanaged.length)
      warnings.push(
        tr(ctx, "message.unmanagedResources") +
          protection.unmanaged
            .slice(0, 25)
            .map((r) => r.kind + " " + r.name + " (" + r.id + ")")
            .join(", "),
      );
  } else warnings.push(tr(ctx, "message.serverProtectionSettingsAreUnavailable"));
  const highest =
    protection?.botTopPosition ?? Math.max(0, ...(bot?.roles ?? []).map((r) => r.position ?? 0));
  for (const key of ctx.config.protectedRoles) {
    const role = ctx.server.role(key);
    if (role.position === undefined || role.position >= highest)
      warnings.push(tr(ctx, "message.botHierarchyCannotProtectRole") + key);
  }
  return { mode: "monitor", warnings };
}
const opt = { user: { type: "user", description: "Account", required: true } } as const;
async function trust(ctx: Context, i: CommandInteraction<typeof opt>, add: boolean) {
  if (!ctx.config.trustedFromCommand || !ctx.server.ownerId || i.user.id !== ctx.server.ownerId) {
    await i.reply(tr(ctx, "message.onlyTheOwnerMayEditCommand"));
    return;
  }
  if (add) await ctx.kv.set("trust:" + i.options.user.id, true, { ttlSeconds: MONTH });
  else await ctx.kv.delete("trust:" + i.options.user.id);
  await i.reply(tr(ctx, "message.trustListUpdated"));
}
export default definePlugin({
  async onStart(ctx) {
    const result = await diagnostics(ctx);
    ctx.status.set(
      "protection",
      result.warnings.length ? tr(ctx, "message.protectionChecksNeedAttentionRunAntinuke") : null,
    );
  },
  events: {
    auditLogEntry: (ctx, entry) => serial(ctx, "audit", () => audit(ctx, entry)),
    async channelDelete(ctx, e) {
      await serial(ctx, "audit", () => structure(ctx, "channelDelete", e.channel.id));
    },
    async roleDelete(ctx, e) {
      await serial(ctx, "audit", () => structure(ctx, "roleDelete", e.role.id));
    },
  },
  tasks: {
    async redact(ctx, p) {
      const { id, channel } = object(p);
      if (typeof id !== "string" || typeof channel !== "string") return;
      const message = await ctx.server.channel({ id: channel }).message(id);
      if (message?.author.id === ctx.bot.user.id)
        await message.edit(tr(ctx, "message.incidentRecordExpired"));
    },
    async settle(ctx, p) {
      const key = object(p).key;
      if (typeof key === "string" && key.startsWith("pair:"))
        await serial(ctx, "audit", () => settle(ctx, key));
    },
  },
  subscriptions: {
    "guard.raid": async (ctx, payload, meta) => {
      const state = object(payload).state;
      if (state !== "started" && state !== "ended") return;
      if (await ctx.kv.get("event:" + meta.id)) return;
      if (state === "started") await ctx.kv.set("raid", true, { ttlSeconds: 86400 });
      else await ctx.kv.delete("raid");
      await ctx.kv.set("event:" + meta.id, true, { ttlSeconds: MONTH });
    },
  },
  routes: {
    "GET /status": {
      access: "moderator",
      async handler(ctx, r): Promise<RouteResponse> {
        if (!staff(r.viewer?.member)) return { status: 403 };
        return diagnostics(ctx);
      },
    },
    "GET /incidents": {
      access: "moderator",
      async handler(ctx, r): Promise<RouteResponse> {
        if (!staff(r.viewer?.member)) return { status: 403 };
        const p = await ctx.kv.list({ prefix: "alert:", limit: 50, cursor: r.query.cursor });
        return { items: p.items.map((x) => x.value), cursor: p.cursor ?? null };
      },
    },
  },
  commands: {
    antinuke: command({
      description: "Audit monitoring",
      ephemeral: true,
      permissions: ["ViewAuditLog"],
      subcommands: {
        status: subcommand({
          description: "Monitoring status",
          async run(ctx, i) {
            if (!staff(i.member)) {
              await i.reply(tr(ctx, "status.staffOnly"));
              return;
            }
            const d = await diagnostics(ctx);
            await i.reply({
              content: [tr(ctx, "status.monitor"), ...d.warnings].join("\n").slice(0, 1900),
              allowedMentions: { users: false, roles: false, everyone: false },
            });
          },
        }),
      },
      groups: {
        trust: {
          description: "Trusted accounts",
          subcommands: {
            add: subcommand({
              description: "Trust for 30 days",
              options: opt,
              run: (ctx, i) => trust(ctx, i, true),
            }),
            remove: subcommand({
              description: "Remove trust",
              options: opt,
              run: (ctx, i) => trust(ctx, i, false),
            }),
          },
        },
      },
    }),
  },
  privacy: {
    async export(ctx, id) {
      return (await memberData(ctx, id, false)).result;
    },
    async erase(ctx, id) {
      return { erased: (await memberData(ctx, id, true)).erased };
    },
  },
});
