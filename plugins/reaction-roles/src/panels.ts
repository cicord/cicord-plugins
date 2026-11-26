/** Panels: rendering, emoji handling, and finding a posted panel again. Independent of the handlers. */
import type { ActionRow, Context, Message, MessagePayload, PluginConfig, Role } from "@cicord/sdk";

export type Panel = PluginConfig["panels"][number];
type PanelOption = Panel["options"][number];

/** Where a panel was posted, stored under `panel:<name>`. */
export interface PostedPanel {
  channelId: string;
  messageId: string;
  /** Fingerprint of the rendered message: unchanged panels are not edited again. */
  hash: string;
}

/** An option with its role resolved. */
export interface ResolvedOption extends PanelOption {
  roleId: string;
  roleName: string;
  roleMention: string;
}

export const panelKey = (name: string): string => `panel:${name}`;
/** Reverse index for reaction panels: message id → panel name. */
export const messageKey = (messageId: string): string => `msg:${messageId}`;

/** Component ids: `rr:<panel>:<roleId>` (button), `rrs:<panel>` (select). */
const buttonId = (panel: string, roleId: string): string => `rr:${panel}:${roleId}`;
const selectId = (panel: string): string => `rrs:${panel}`;

export function findPanel(ctx: Context, name: string): Panel | undefined {
  return ctx.config.panels.find((p) => p.name === name);
}

/** Resolves the roles of a panel. Options whose role no longer exists are dropped. */
export function resolveOptions(ctx: Context, panel: Panel): ResolvedOption[] {
  const out: ResolvedOption[] = [];
  for (const option of panel.options) {
    let role: Role;
    try {
      role = ctx.server.role(option.role);
    } catch {
      ctx.log.warn("reaction-roles: unknown role in a panel", {
        panel: panel.name,
        role: option.role,
      });
      continue;
    }
    if (out.some((o) => o.roleId === role.id)) continue;
    out.push({ ...option, roleId: role.id, roleName: role.name, roleMention: role.mention });
  }
  return out;
}

const CUSTOM = /^<?(a)?:?([A-Za-z0-9_~-]+):(\d{15,25})>?$/;

/**
 * Normalized emoji, as reaction events report it: a unicode emoji (without the U+FE0F
 * variation selector), or `name:id` for a custom one (`<:name:id>`, `<a:name:id>` accepted).
 */
export function normalizeEmoji(emoji: string): string {
  const s = emoji.trim();
  const m = CUSTOM.exec(s);
  if (m) return `${m[2]}:${m[3]}`;
  return s.replaceAll("️", "");
}

/** The emoji as it renders in message text. */
export function displayEmoji(emoji: string): string {
  const s = emoji.trim();
  const m = CUSTOM.exec(s);
  return m ? `<${m[1] ? "a" : ""}:${m[2]}:${m[3]}>` : s;
}

/** The emoji as the API takes it (react, buttons, select options). */
export function apiEmoji(emoji: string): string {
  const s = emoji.trim();
  const m = CUSTOM.exec(s);
  return m ? `${m[1] ? "a:" : ""}${m[2]}:${m[3]}` : s;
}

function lines(options: ResolvedOption[]): string[] {
  return options.map((o) => {
    const emoji = o.emoji ? `${displayEmoji(o.emoji)} ` : "";
    const description = o.description ? ` — ${o.description}` : "";
    return `${emoji}${o.roleMention}${description}`;
  });
}

function footer(panel: Panel, ctx: Context): string {
  const parts = [panel.mode === "single" ? ctx.i18n.t("single") : ctx.i18n.t("multiple")];
  if (panel.style === "reactions") parts.push(ctx.i18n.t("unreact"));
  else parts.push(ctx.i18n.t("unpick"));
  if (panel.requiredRole) {
    try {
      parts.push(ctx.i18n.t("requires", { role: ctx.server.role(panel.requiredRole).name }));
    } catch {
      // unknown role: the click handler explains it
    }
  }
  return parts.join(" ");
}

/** The panel message. Reaction panels list emoji → role; buttons list descriptions when any. */
export function renderPanel(ctx: Context, panel: Panel, options: ResolvedOption[]): MessagePayload {
  const text: string[] = [];
  if (panel.description) text.push(panel.description);
  const listed =
    panel.style === "reactions" ||
    (panel.style === "buttons" && options.some((o) => o.description));
  if (listed && options.length > 0) text.push(lines(options).join("\n"));
  const components: ActionRow[] = [];
  if (panel.style === "buttons") {
    for (let i = 0; i < options.length; i += 5) {
      components.push({
        type: "row",
        components: options.slice(i, i + 5).map((o) => ({
          type: "button" as const,
          id: buttonId(panel.name, o.roleId),
          label: (o.label ?? o.roleName).slice(0, 80),
          style: "secondary" as const,
          ...(o.emoji ? { emoji: apiEmoji(o.emoji) } : {}),
        })),
      });
    }
  } else if (panel.style === "select" && options.length > 0) {
    components.push({
      type: "row",
      components: [
        {
          type: "select",
          id: selectId(panel.name),
          placeholder: panel.mode === "single" ? ctx.i18n.t("choose") : ctx.i18n.t("chooseMany"),
          minValues: 0,
          maxValues: panel.mode === "single" ? 1 : options.length,
          options: options.map((o) => ({
            value: o.roleId,
            label: (o.label ?? o.roleName).slice(0, 100),
            ...(o.description ? { description: o.description } : {}),
            ...(o.emoji ? { emoji: apiEmoji(o.emoji) } : {}),
          })),
        },
      ],
    });
  }
  return {
    embeds: [
      {
        title: panel.title === "Pick your roles" ? ctx.i18n.t("panelTitle") : panel.title,
        ...(text.length > 0 ? { description: text.join("\n\n") } : {}),
        color: panel.color,
        footer: { text: footer(panel, ctx) },
      },
    ],
    components,
    allowedMentions: { users: false, roles: false, everyone: false },
  };
}

/** Stable fingerprint of a rendered panel (and its style, which decides the reactions). */
export function fingerprint(panel: Panel, message: MessagePayload): string {
  const s = JSON.stringify({ style: panel.style, message });
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${s.length}:${h.toString(16)}`;
}

/** Fetches the message of a panel (undefined when it was deleted). */
export async function findMessage(
  ctx: Context,
  channelId: string,
  messageId: string,
): Promise<Message | undefined> {
  return ctx.server.channel({ id: channelId }).message(messageId);
}

/** True when a Discord error is a missing permission (403), e.g. the role hierarchy. */
export function isForbidden(error: unknown): boolean {
  return /missing permissions|forbidden|50013|50001|at or above/i.test(String(error));
}

/** What to tell a member (and log) when a role cannot be given or taken. */
export function hierarchyHelp(ctx: Context, roleName: string): string {
  return ctx.i18n.t("hierarchy", { role: roleName });
}
