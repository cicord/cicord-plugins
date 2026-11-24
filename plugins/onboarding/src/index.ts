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
  onStart(ctx) {
    ctx.log.info("onboarding ready", { steps: ctx.config.steps.length });
  },

  routes: {
    /** Steps with options resolved to role names/colors, and the viewer's current picks. */
    "GET /steps": {
      access: "member",
      async handler(ctx, request) {
        const member = request.viewer?.member;
        if (!member)
          return fail(403, "forbidden", "only members of the server can do the onboarding");
        const record = await ctx.kv.get<CompletionRecord>(completionKey(member.id));
        return resolveSteps(ctx, member, record);
      },
    },

    /** `{answers: {stepId: roleKey[]}}` → adds/removes the configured roles. */
    "POST /complete": {
      access: "member",
      async handler(ctx, request) {
        const member = request.viewer?.member;
        if (!member)
          return fail(403, "forbidden", "only members of the server can do the onboarding");

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
          return fail(503, "unavailable", "the roles could not be updated, please try again");
        }

        const key = completionKey(member.id);
        const first = (await ctx.kv.get(key)) === undefined;
        const record: CompletionRecord = {
          at: new Date().toISOString(),
          answers: answersRecord(parsed.answers),
        };
        await ctx.kv.set(key, record);
        if (first) await ctx.kv.increment("stats:completed");

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
          message: ctx.config.successMessage,
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
        const url = await ctx.portal.link("/onboarding", {
          member: interaction.member ?? interaction.user,
        });
        await interaction.reply({
          ephemeral: true,
          content: ctx.config.linkMessage,
          components: [
            {
              type: "row",
              components: [{ type: "link", label: ctx.config.buttonLabel, emoji: "✨", url }],
            },
          ],
        });
      },
    }),
  },
});
