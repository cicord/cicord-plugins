import {
  action,
  command,
  definePlugin,
  subcommand,
  type Context,
  type Interaction,
  type Json,
  type Member,
} from "@cicord/sdk";
import type { Grant, Revoke, TempRoleExpired } from "./contracts.ts";
import {
  changed,
  expire,
  grant,
  grants,
  joined,
  leave,
  manager,
  revoke,
  scan,
  subjectData,
  validateRoles,
} from "./roles.ts";

function response(
  ctx: Context,
  it: Interaction,
  key: string,
  vars: Record<string, string | number> = {},
) {
  return ctx.i18n.t(key, vars, it.locale ? { locale: it.locale } : {});
}
function seconds(raw: string) {
  const match = /^(\d+)(s|m|h|d|w)$/i.exec(raw.trim());
  if (!match) return 0;
  const unit = ({ s: 1, m: 60, h: 3600, d: 86400, w: 604800 } as Record<string, number>)[
    match[2]!.toLowerCase()
  ]!;
  return Number(match[1]) * unit;
}
async function invoke(ctx: Context, it: Interaction, fn: (m: Member) => Promise<string>) {
  try {
    await manager(ctx, it.member);
    await it.reply({
      content: await fn(it.member!),
      ephemeral: true,
      allowedMentions: { users: false, roles: false, everyone: false },
    });
  } catch (err) {
    await it.reply({
      content: err instanceof Error ? err.message : response(ctx, it, "error.denied"),
      ephemeral: true,
      allowedMentions: { users: false, roles: false, everyone: false },
    });
  }
}
const memberOption = { type: "user", description: "Server member", required: true } as const;
const roleOption = { type: "role", description: "Role to manage", required: true } as const;
const reasonOption = { type: "string", description: "Audit reason", maxLength: 256 } as const;
export default definePlugin({
  async onStart(ctx) {
    await validateRoles(ctx);
    if (ctx.config.enabled) await ctx.schedule.after(1000, "scan");
  },
  commands: {
    temprole: command({
      description: "Manage temporary roles",
      ephemeral: true,
      subcommands: {
        add: subcommand({
          description: "Grant or extend a temporary role",
          options: {
            user: memberOption,
            role: roleOption,
            duration: {
              type: "string",
              description: "Duration, for example 30m or 7d",
              required: true,
            },
            reason: reasonOption,
          },
          async run(ctx, it) {
            await invoke(ctx, it, async (actor) => {
              const result = await grant(
                ctx,
                {
                  userId: it.options.user.id,
                  role: it.options.role.id,
                  durationSeconds: seconds(it.options.duration),
                  reason: it.options.reason,
                },
                "interaction:" + it.id,
                actor,
              );
              return response(ctx, it, "grant", {
                role: it.options.role.name,
                time: `<t:${Math.floor(result.expiresAt / 1000)}:R>`,
              });
            });
          },
        }),
        remove: subcommand({
          description: "Revoke a temporary role",
          options: { user: memberOption, role: roleOption, reason: reasonOption },
          async run(ctx, it) {
            await invoke(ctx, it, async (actor) => {
              const result = await revoke(
                ctx,
                { userId: it.options.user.id, role: it.options.role.id, reason: it.options.reason },
                actor,
              );
              return response(ctx, it, result.revoked ? "revoked" : "absent");
            });
          },
        }),
        list: subcommand({
          description: "List active temporary roles",
          options: { user: { type: "user", description: "Filter by member" } },
          async run(ctx, it) {
            await invoke(ctx, it, async () => {
              const rows = await grants(ctx, it.options.user?.id);
              if (!rows.length) return response(ctx, it, "empty");
              const shown = rows
                .slice(0, 18)
                .map(
                  (r) =>
                    `<@${r.userId}> · <@&${r.roleId}> · <t:${Math.floor(r.expiresAt / 1000)}:R>`,
                );
              if (rows.length > shown.length)
                shown.push(response(ctx, it, "more", { n: rows.length - shown.length }));
              return shown.join("\n");
            });
          },
        }),
      },
    }),
  },
  actions: {
    grantTemporary: action({
      async run(ctx, input: Grant, call) {
        return grant(ctx, input, call.idempotencyKey);
      },
    }),
    revoke: action({
      async run(ctx, input: Revoke) {
        return revoke(ctx, input);
      },
    }),
  },
  events: {
    memberLeave: (ctx, user, previous) => leave(ctx, user.id, previous),
    memberJoin: joined,
    memberUpdate: (ctx, member) => changed(ctx, member),
  },
  schedules: { tenure: { cron: "*/5 * * * *", run: scan } },
  tasks: {
    scan: async (ctx) => {
      await scan(ctx);
    },
    expire: async (ctx, payload) => {
      const p = payload as TempRoleExpired | undefined;
      if (
        !p ||
        typeof p.userId !== "string" ||
        typeof p.roleId !== "string" ||
        !Number.isSafeInteger(p.expiresAt)
      )
        throw new Error("Invalid expiry payload");
      await expire(ctx, p);
    },
  },
  privacy: {
    async export(ctx, id): Promise<Json> {
      return (await subjectData(ctx, id, false)).result;
    },
    async erase(ctx, id) {
      return { erased: (await subjectData(ctx, id, true)).erased };
    },
  },
});
