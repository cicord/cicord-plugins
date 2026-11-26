import {
  command,
  definePlugin,
  type ComponentInteraction,
  type Context,
  type Json,
  type Member,
  type Message,
} from "@cicord/sdk";
import {
  apiEmoji,
  findMessage,
  findPanel,
  fingerprint,
  hierarchyHelp,
  isForbidden,
  messageKey,
  normalizeEmoji,
  panelKey,
  renderPanel,
  resolveOptions,
  type Panel,
  type PostedPanel,
  type ResolvedOption,
} from "./panels.ts";

type SyncStatus = "posted" | "updated" | "unchanged" | "moved" | "reposted";

interface SyncResult {
  status: SyncStatus;
  channel: string;
  /** Options left out of a reaction panel, with the reason. */
  skipped: string[];
}

/** Discord allows at most 20 different reactions on a message. */
const MAX_REACTIONS = 20;

/**
 * The options a panel actually offers: a reaction panel only those with an emoji, and at
 * most 20 of them.
 */
function offered(ctx: Context, panel: Panel): { options: ResolvedOption[]; skipped: string[] } {
  const all = resolveOptions(ctx, panel);
  if (panel.style !== "reactions") return { options: all, skipped: [] };
  const withEmoji = all.filter((o) => o.emoji);
  return {
    options: withEmoji.slice(0, MAX_REACTIONS),
    skipped: [
      ...all.filter((o) => !o.emoji).map((o) => ctx.i18n.t("noEmoji", { role: o.roleName })),
      ...withEmoji
        .slice(MAX_REACTIONS)
        .map((o) => ctx.i18n.t("overLimit", { role: o.roleName, n: MAX_REACTIONS })),
    ],
  };
}

/**
 * Posts a panel, or edits its message in place when it is still there (idempotent: an
 * unchanged panel is not touched). `force` posts a new message even if the old one exists.
 */
async function syncPanel(ctx: Context, panel: Panel, force = false): Promise<SyncResult> {
  const channel = ctx.server.channel(panel.channel);
  const { options, skipped } = offered(ctx, panel);
  const message = renderPanel(ctx, panel, options);
  const hash = fingerprint(panel, message);
  const stored = (await ctx.kv.get(panelKey(panel.name))) as unknown as PostedPanel | undefined;

  let status: SyncStatus = "posted";
  if (stored && stored.channelId === channel.id && !force) {
    const existing = await findMessage(ctx, stored.channelId, stored.messageId);
    if (existing) {
      if (stored.hash === hash) return { status: "unchanged", channel: channel.mention, skipped };
      await existing.edit(message);
      if (panel.style === "reactions") await addReactions(ctx, existing, options);
      await ctx.kv.set(panelKey(panel.name), { ...stored, hash });
      return { status: "updated", channel: channel.mention, skipped };
    }
    status = "reposted"; // the message was deleted
  } else if (stored) {
    status = stored.channelId === channel.id ? "reposted" : "moved";
  }

  const posted = await channel.send(message);
  if (panel.style === "reactions") await addReactions(ctx, posted, options);
  const record: PostedPanel = { channelId: channel.id, messageId: posted.id, hash };
  await ctx.kv.set(panelKey(panel.name), record as unknown as Json);
  await ctx.kv.set(messageKey(posted.id), panel.name);
  if (stored) await ctx.kv.delete(messageKey(stored.messageId));
  ctx.log.info("reaction-roles: panel posted", { panel: panel.name, message: posted.id, status });
  return { status, channel: channel.mention, skipped };
}

/** Adds the emojis to pick from (adding a reaction twice is a no-op on Discord). */
async function addReactions(ctx: Context, message: Message, options: ResolvedOption[]) {
  for (const o of options) {
    if (!o.emoji) continue;
    try {
      await message.react(apiEmoji(o.emoji));
    } catch (error) {
      ctx.log.warn("reaction-roles: could not add a reaction (unknown emoji?)", {
        emoji: o.emoji,
        error: String(error),
      });
    }
  }
}

/** Why a member cannot use a panel, or undefined. */
function refusal(ctx: Context, panel: Panel, member: Member | undefined): string | undefined {
  if (!member) return ctx.i18n.t("serverOnly");
  if (panel.requiredRole && !member.hasRole(panel.requiredRole)) {
    let name = panel.requiredRole;
    try {
      name = ctx.server.role(panel.requiredRole).name;
    } catch {
      // keep the key
    }
    return ctx.i18n.t("need", { role: name });
  }
  return undefined;
}

/**
 * Applies a member's choice: adds `add`, removes `remove`. Stops at the first error and
 * returns the lines to show (what changed, or why it failed).
 */
async function apply(
  ctx: Context,
  member: Member,
  add: ResolvedOption[],
  remove: ResolvedOption[],
  panel: Panel,
): Promise<{ ok: boolean; lines: string[] }> {
  const lines: string[] = [];
  const reason = `reaction-roles: panel ${panel.name}`;
  const run = async (o: ResolvedOption, adding: boolean): Promise<boolean> => {
    try {
      if (adding) await member.addRole({ id: o.roleId }, reason);
      else await member.removeRole({ id: o.roleId }, reason);
      lines.push(ctx.i18n.t(adding ? "added" : "removed", { role: o.roleMention }));
      return true;
    } catch (error) {
      ctx.log.warn("reaction-roles: role change failed", {
        panel: panel.name,
        role: o.roleId,
        member: member.id,
        error: String(error),
      });
      lines.push(
        isForbidden(error)
          ? hierarchyHelp(ctx, o.roleName)
          : ctx.i18n.t("error", { role: o.roleMention }),
      );
      return false;
    }
  };
  // Additions first: when a role cannot be given (hierarchy), the member keeps the roles
  // they had instead of losing them in a half-done swap.
  for (const o of add) if (!(await run(o, true))) return { ok: false, lines };
  for (const o of remove) if (!(await run(o, false))) return { ok: false, lines };
  return { ok: true, lines };
}

/** Panel name in a component id (`rr:<panel>:<role>` / `rrs:<panel>`). */
function panelOf(interaction: ComponentInteraction): string {
  return interaction.componentId.split(":")[1] ?? "";
}

async function reply(interaction: ComponentInteraction, text: string): Promise<void> {
  await interaction.reply({
    content: text,
    ephemeral: true,
    allowedMentions: { users: false, roles: false, everyone: false },
  });
}

/** Common checks of a component click: the panel still exists and the member may use it. */
async function prepare(
  ctx: Context,
  interaction: ComponentInteraction,
): Promise<{ panel: Panel; member: Member; options: ResolvedOption[] } | undefined> {
  // No explicit defer: a component deferral is a silent "deferred update", which the
  // runtime also does on its own after 2 s; the ephemeral reply then becomes a follow-up.
  if (ctx.config.enabled === false) {
    await reply(interaction, ctx.i18n.t("disabled"));
    return;
  }
  const panel = findPanel(ctx, panelOf(interaction));
  if (!panel || panel.style === "reactions") {
    await reply(interaction, ctx.i18n.t("expired"));
    return undefined;
  }
  const problem = refusal(ctx, panel, interaction.member);
  if (problem) {
    await reply(interaction, problem);
    return undefined;
  }
  return { panel, member: interaction.member as Member, options: offered(ctx, panel).options };
}

/** Reaction panel lookup: the panel of a message, and the option of an emoji. */
async function reactionTarget(
  ctx: Context,
  messageId: string,
  emoji: string,
): Promise<{ panel: Panel; option: ResolvedOption; options: ResolvedOption[] } | undefined> {
  const name = await ctx.kv.get<string>(messageKey(messageId));
  if (!name) return undefined;
  const panel = findPanel(ctx, name);
  if (!panel || panel.style !== "reactions") return undefined;
  const options = offered(ctx, panel).options;
  const wanted = normalizeEmoji(emoji);
  const option = options.find((o) => o.emoji && normalizeEmoji(o.emoji) === wanted);
  return option ? { panel, option, options } : undefined;
}

export default definePlugin({
  async onStart(ctx) {
    await ctx.kv.set("meta:schema", 1);
    if (ctx.config.enabled === false || !ctx.config.syncOnStart) return;
    for (const panel of ctx.config.panels) {
      try {
        const r = await syncPanel(ctx, panel);
        if (r.skipped.length > 0)
          ctx.log.warn("reaction-roles: options left out of a reaction panel", {
            panel: panel.name,
            roles: r.skipped,
          });
      } catch (error) {
        ctx.log.warn("reaction-roles: could not sync a panel", {
          panel: panel.name,
          error: String(error),
        });
      }
    }
  },

  commands: {
    "role-panel": command({
      description: "Post or refresh the role panels (edits them in place)",
      ephemeral: true,
      permissions: ["ManageRoles"],
      options: {
        panel: { type: "string", description: "Panel name (default: every panel)" },
        new_message: {
          type: "boolean",
          description: "Post a new message even if the panel is still there",
        },
      },
      async run(ctx, interaction) {
        if (ctx.config.enabled === false) return interaction.reply(ctx.i18n.t("disabled"));
        const { panel: name, new_message: force = false } = interaction.options;
        const panels = name
          ? ctx.config.panels.filter((p) => p.name === name)
          : [...ctx.config.panels];
        if (panels.length === 0) {
          const known = ctx.config.panels.map((p) => `\`${p.name}\``).join(", ");
          await interaction.reply(
            name
              ? ctx.i18n.t("noPanel", { name, known: known || ctx.i18n.t("none") })
              : ctx.i18n.t("empty"),
          );
          return;
        }
        const lines: string[] = [];
        for (const panel of panels) {
          try {
            const r = await syncPanel(ctx, panel, force);
            let line = `**${panel.name}**: ${ctx.i18n.t("sync." + r.status)} ${r.channel}.`;
            if (r.status === "moved") line += ctx.i18n.t("dmGone");
            if (r.skipped.length > 0)
              line += ctx.i18n.t("skipped", { roles: r.skipped.join(", ") });
            lines.push(line);
          } catch (error) {
            ctx.log.warn("reaction-roles: could not post a panel", {
              panel: panel.name,
              error: String(error),
            });
            lines.push(
              ctx.i18n.t("panelFailed", {
                name: panel.name,
                reason: isForbidden(error) ? ctx.i18n.t("channelDenied") : "",
              }),
            );
          }
        }
        await interaction.reply(lines.join("\n"));
      },
    }),
  },

  components: {
    /** Button `rr:<panel>:<roleId>`: toggles the role (single mode: swaps it). */
    async rr(ctx, interaction) {
      const target = await prepare(ctx, interaction);
      if (!target) return;
      const { panel, member, options } = target;
      const roleId = interaction.componentId.split(":")[2] ?? "";
      // Never trust the id alone: the role must be an option of the panel as configured now.
      const option = options.find((o) => o.roleId === roleId);
      if (!option) {
        await reply(interaction, ctx.i18n.t("gone"));
        return;
      }
      const has = member.hasRole({ id: option.roleId });
      const others =
        panel.mode === "single"
          ? options.filter((o) => o.roleId !== option.roleId && member.hasRole({ id: o.roleId }))
          : [];
      const r = has
        ? await apply(ctx, member, [], [option], panel)
        : await apply(ctx, member, [option], others, panel);
      await reply(interaction, r.lines.join("\n"));
    },

    /** Select `rrs:<panel>`: the member's roles of the panel become exactly the selection. */
    async rrs(ctx, interaction) {
      const target = await prepare(ctx, interaction);
      if (!target) return;
      const { panel, member, options } = target;
      const picked = new Set(interaction.values);
      let chosen = options.filter((o) => picked.has(o.roleId));
      if (panel.mode === "single") chosen = chosen.slice(0, 1);
      const chosenIds = new Set(chosen.map((o) => o.roleId));
      const add = chosen.filter((o) => !member.hasRole({ id: o.roleId }));
      const remove = options.filter(
        (o) => !chosenIds.has(o.roleId) && member.hasRole({ id: o.roleId }),
      );
      if (add.length + remove.length === 0) {
        await reply(interaction, ctx.i18n.t("same"));
        return;
      }
      const r = await apply(ctx, member, add, remove, panel);
      await reply(interaction, r.lines.join("\n"));
    },
  },

  events: {
    async reactionAdd(ctx, { message, user, emoji }) {
      if (ctx.config.enabled === false || user.id === ctx.bot.user.id || user.bot) return;
      const target = await reactionTarget(ctx, message.id, emoji);
      if (!target) return;
      const { panel, option, options } = target;
      const member = await ctx.server.member(user.id);
      const problem = refusal(ctx, panel, member);
      if (problem || !member) {
        // A reaction cannot be answered privately; the panel footer states the requirement.
        ctx.log.info("reaction-roles: reaction ignored", { panel: panel.name, user: user.id });
        return;
      }
      if (member.hasRole({ id: option.roleId })) return;
      // Single mode swaps the role. The SDK cannot remove the member's other reaction, so it
      // stays on the message; removing it later is a no-op.
      const others =
        panel.mode === "single"
          ? options.filter((o) => o.roleId !== option.roleId && member.hasRole({ id: o.roleId }))
          : [];
      const r = await apply(ctx, member, [option], others, panel);
      if (!r.ok) ctx.log.warn("reaction-roles: " + r.lines.at(-1), { panel: panel.name });
    },

    async reactionRemove(ctx, { message, user, emoji }) {
      if (ctx.config.enabled === false || user.id === ctx.bot.user.id || user.bot) return;
      const target = await reactionTarget(ctx, message.id, emoji);
      if (!target) return;
      const member = await ctx.server.member(user.id);
      if (!member || !member.hasRole({ id: target.option.roleId })) return;
      const r = await apply(ctx, member, [], [target.option], target.panel);
      if (!r.ok) ctx.log.warn("reaction-roles: " + r.lines.at(-1), { panel: target.panel.name });
    },
  },
});
