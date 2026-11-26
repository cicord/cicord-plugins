import { command, definePlugin, type RouteResponse } from "@cicord/sdk";
import {
  answersRecord,
  completionKey,
  parseAnswers,
  planRoles,
  resolveSteps,
  rolesAfter,
  type CompleteResponse,
  type CompletionRecord,
} from "./onboarding.ts";

/** Error responses use the runtime API error shape, so `CicordApiError` parses them. */
function fail(
  status: number,
  code: string,
  message: string,
  diagnostics: { severity: "error"; path: string; message: string }[] = [],
): RouteResponse {
  return {
    status,
    body: { error: diagnostics.length > 0 ? { code, message, diagnostics } : { code, message } },
  };
}

export default definePlugin({
  privacy: {
    async export(ctx, id) {
      return (await ctx.kv.get(completionKey(id))) ?? {};
    },
    async erase(ctx, id) {
      const k = completionKey(id),
        exists = await ctx.kv.get(k);
      await ctx.kv.delete(k);
      return { erased: exists ? 1 : 0 };
    },
  },
  async onStart(ctx) {
    if (ctx.config.enabled !== false && (await ctx.kv.get("meta:schema")) !== 2)
      await ctx.schedule.after(1, "migrate", {});
    ctx.log.info("onboarding ready", { steps: ctx.config.steps?.length ?? 0 });
  },

  tasks: {
    async migrate(ctx) {
      if ((await ctx.kv.get("meta:schema")) === 2) return;
      const cursor = await ctx.kv.get<string>("meta:cursor");
      const batch = await ctx.kv.list<CompletionRecord>({
        prefix: "completed:",
        limit: 40,
        cursor,
      });
      for (const { key } of batch.items) {
        const e = await ctx.kv.getEntry<CompletionRecord>(key);
        if (!e) continue;
        const ttl = Math.floor((Date.parse(e.value.at) + 365 * 86400000 - Date.now()) / 1000);
        const tx = ctx.kv.atomic().check(key, e.version);
        if (ttl > 0) tx.set(key, e.value, { ttlSeconds: ttl });
        else tx.delete(key);
        await tx.commit();
      }
      if (batch.cursor) {
        await ctx.schedule.after(1000, "migrate", {});
        await ctx.kv.set("meta:cursor", batch.cursor);
      } else await ctx.kv.atomic().delete("meta:cursor").set("meta:schema", 2).commit();
    },
  },
  routes: {
    /** Steps with options resolved to role names/colors, and the viewer's current picks. */
    "GET /steps": {
      access: "member",
      async handler(ctx, request) {
        if (ctx.config.enabled === false) return { status: 404 };
        const member = request.viewer?.member;
        if (!member) return fail(403, "forbidden", ctx.i18n.t("memberOnly"));
        const record = await ctx.kv.get<CompletionRecord>(completionKey(member.id));
        return resolveSteps(ctx, member, record);
      },
    },

    /** `{answers: {stepId: roleKey[]}}` → adds/removes the configured roles. */
    "POST /complete": {
      access: "member",
      async handler(ctx, request) {
        if (ctx.config.enabled === false) return { status: 404 };
        const member = request.viewer?.member;
        if (!member) return fail(403, "forbidden", ctx.i18n.t("memberOnly"));

        const parsed = parseAnswers(ctx, request.body);
        if (!parsed.ok) return fail(parsed.status, "invalid", parsed.message, parsed.problems);

        const plan = planRoles(ctx, member, parsed.answers);
        try {
          for (const role of plan.add)
            await member.addRole(role.key ?? { id: role.id }, "onboarding");
          for (const role of plan.remove)
            await member.removeRole(role.key ?? { id: role.id }, "onboarding");
        } catch (error) {
          ctx.log.error("onboarding: role update failed", {
            member: member.id,
            error: error instanceof Error ? error.message : String(error),
          });
          return fail(503, "unavailable", ctx.i18n.t("roleError"));
        }

        const key = completionKey(member.id);
        const previous = await ctx.kv.getEntry(key);
        const record: CompletionRecord = {
          at: new Date().toISOString(),
          answers: answersRecord(parsed.answers),
        };
        const tx = ctx.kv
          .atomic()
          .check(key, previous?.version ?? null)
          .set(key, record, { ttlSeconds: 365 * 86400 });
        if (!previous) tx.increment("stats:completed", 1);
        if (!(await tx.commit()).ok)
          return fail(409, "conflict", "Role choices changed. Reload the form.");

        ctx.log.info("onboarding completed", {
          member: member.id,
          added: plan.add.map((r) => r.key ?? r.id),
          removed: plan.remove.map((r) => r.key ?? r.id),
        });

        const response: CompleteResponse = {
          completed: true,
          completedAt: record.at,
          roles: rolesAfter(member, plan),
          added: plan.add.map((r) => r.key ?? r.id),
          removed: plan.remove.map((r) => r.key ?? r.id),
          message:
            ctx.config.successMessage === "You're all set!"
              ? ctx.i18n.t("successMessage")
              : ctx.config.successMessage,
        };
        return response;
      },
    },
  },

  commands: {
    onboarding: command({
      description: "Pick your roles on the community portal",
      ephemeral: true,
      async run(ctx, interaction) {
        if (ctx.config.enabled === false) return interaction.reply(ctx.i18n.t("disabled"));
        const url = await ctx.portal.link("/onboarding", {
          member: interaction.member ?? interaction.user,
        });
        await interaction.reply({
          ephemeral: true,
          content:
            ctx.config.linkMessage === "Pick your roles on the community portal:"
              ? ctx.i18n.t("linkMessage")
              : ctx.config.linkMessage,
          components: [
            {
              type: "row",
              components: [
                {
                  type: "link",
                  label:
                    ctx.config.buttonLabel === "Open onboarding"
                      ? ctx.i18n.t("buttonLabel")
                      : ctx.config.buttonLabel,
                  emoji: "✨",
                  url,
                },
              ],
            },
          ],
        });
      },
    }),
  },
});
