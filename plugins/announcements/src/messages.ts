/** Announcement messages and mention safety. Independent of the handlers. */
import type { Context, Embed, MessagePayload, PluginConfig } from "@cicord/sdk";

export type Configured = PluginConfig["announcements"][number];

/** Who an announcement pings: role ids, a user id, @everyone/@here. */
export interface Mentions {
  roles: string[];
  user?: string;
  everyone?: boolean;
  here?: boolean;
}

/** An /announce message waiting for its task, stored under `ad:<id>`. */
export interface Scheduled {
  id: number;
  channelId: string;
  /** Epoch ms. */
  at: number;
  title?: string;
  body: string;
  mentions: Mentions;
  by: { id: string; name: string };
  taskId?: string;
  createdAt: string;
}

/** An /announce draft between the command and its modal, stored under `draft:<n>`. */
export interface Draft {
  channelId: string;
  at: number;
  mentions: Mentions;
}

export const adKey = (id: number): string => `ad:${String(id).padStart(8, "0")}`;
export const draftKey = (n: number): string => `draft:${n}`;
export const firedKey = (name: string): string => `fired:${name}`;

const ZWSP = "​";

/**
 * Makes text safe for `content`: @everyone/@here never ping unless allowed, and when roles
 * may ping (some are mentioned on purpose) other role mentions are turned into plain names.
 * The SDK's allowedMentions only has on/off switches, not id lists, hence the rewriting.
 */
function neutralize(
  ctx: Context,
  text: string,
  opts: { everyone: boolean; roles: string[] },
): string {
  let out = text;
  if (!opts.everyone) out = out.replace(/@(everyone|here)/g, `@${ZWSP}$1`);
  if (opts.roles.length > 0) {
    out = out.replace(/<@&(\d+)>/g, (whole, id: string) => {
      if (opts.roles.includes(id)) return whole;
      try {
        return `@${ctx.server.role({ id }).name}`;
      } catch {
        return "@role";
      }
    });
  }
  return out;
}

/** The mention line and the allowedMentions that let exactly these mentions ping. */
function mentionPart(
  ctx: Context,
  m: Mentions,
): { line: string; allowed: NonNullable<MessagePayload["allowedMentions"]>; dropped: boolean } {
  const parts = m.roles.map((id) => `<@&${id}>`);
  if (m.user) parts.push(`<@${m.user}>`);
  const wantsEveryone = Boolean(m.everyone || m.here);
  const everyone = wantsEveryone && ctx.config.allowEveryone;
  if (everyone && m.everyone) parts.push("@everyone");
  if (everyone && m.here) parts.push("@here");
  return {
    line: parts.join(" "),
    allowed: { roles: m.roles.length > 0, users: Boolean(m.user), everyone },
    dropped: wantsEveryone && !everyone,
  };
}

/** Role ids of the configured mentions (unknown roles are logged and left out). */
function configuredMentions(ctx: Context, a: Configured): Mentions {
  const roles: string[] = [];
  for (const key of a.mentions?.roles ?? []) {
    try {
      roles.push(ctx.server.role(key).id);
    } catch {
      ctx.log.warn("announcements: unknown role in mentions", { announcement: a.name, role: key });
    }
  }
  return {
    roles,
    ...(a.mentions?.everyone ? { everyone: true } : {}),
    ...(a.mentions?.here ? { here: true } : {}),
  };
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Message of a configured announcement, or undefined when it has nothing to say. */
export function renderConfigured(ctx: Context, a: Configured): MessagePayload | undefined {
  const m = mentionPart(ctx, configuredMentions(ctx, a));
  if (m.dropped)
    ctx.log.warn("announcements: @everyone/@here left out (allowEveryone is off)", {
      announcement: a.name,
    });
  const body = a.content
    ? neutralize(ctx, a.content, {
        everyone: m.allowed.everyone ?? false,
        roles: configuredMentions(ctx, a).roles,
      })
    : "";
  const content = clip([m.line, body].filter(Boolean).join("\n"), 2000);
  const e = a.embed;
  const embed: Embed | undefined =
    e && (e.title || e.description || e.imageUrl)
      ? {
          ...(e.title ? { title: e.title } : {}),
          ...(e.description ? { description: e.description } : {}),
          ...(e.url ? { url: e.url } : {}),
          ...(e.color ? { color: e.color } : {}),
          ...(e.imageUrl ? { image: { url: e.imageUrl } } : {}),
          ...(e.footer ? { footer: { text: e.footer } } : {}),
        }
      : undefined;
  if (!body && !embed) return undefined;
  return {
    ...(content ? { content } : {}),
    ...(embed ? { embeds: [embed] } : {}),
    allowedMentions: m.allowed,
  };
}

/** Message of an /announce announcement: mentions as text, the body in an embed (never pings). */
export function renderScheduled(ctx: Context, s: Scheduled): MessagePayload {
  const m = mentionPart(ctx, s.mentions);
  const embed: Embed = {
    ...(s.title ? { title: s.title } : {}),
    description: s.body,
    color: ctx.config.color,
  };
  return {
    ...(m.line ? { content: m.line } : {}),
    embeds: [embed],
    allowedMentions: m.allowed,
  };
}

/** Short preview of a text for lists. */
export function preview(text: string, max = 60): string {
  const one = text.replace(/\s+/g, " ").trim();
  return clip(one, max);
}

const UNIT_MINUTES: Record<string, number> = {
  m: 1,
  min: 1,
  mins: 1,
  minute: 1,
  minutes: 1,
  h: 60,
  hour: 60,
  hours: 60,
  d: 1440,
  day: 1440,
  days: 1440,
  w: 10080,
  week: 10080,
  weeks: 10080,
};

/**
 * Parses the `when` of /announce, relative to `nowMs`:
 * empty or "now"; a delay ("in 2h", "1h30m", "45 min", "3 days"); a local time "18:30"
 * (today, or tomorrow when past); a local date "2026-12-24 18:00".
 * `toUtcMs(local minutes)` converts a local time of the configured zone.
 */
export function parseWhen(
  text: string,
  nowMs: number,
  localNow: number,
  toUtcMs: (localMinute: number) => number,
): number | string {
  const t = text.trim().toLowerCase();
  if (t === "" || t === "now") return nowMs;
  const delay = /^(?:in\s+)?((?:\d+\s*[a-z]+\s*)+)$/.exec(t);
  if (delay) {
    let minutes = 0;
    for (const [, n, unit] of (delay[1] ?? "").matchAll(/(\d+)\s*([a-z]+)/g)) {
      const per = UNIT_MINUTES[unit ?? ""];
      if (per === undefined) return `Unknown unit "${unit}": use m, h, d or w.`;
      minutes += Number(n) * per;
    }
    return nowMs + minutes * 60_000;
  }
  const time = /^(\d{1,2})[:h](\d{2})$/.exec(t);
  if (time) {
    const h = Number(time[1]);
    const mi = Number(time[2]);
    if (h > 23 || mi > 59) return `"${text}" is not a time of day.`;
    const today = Math.floor(localNow / 1440) * 1440 + h * 60 + mi;
    const local = today > localNow ? today : today + 1440;
    return toUtcMs(local);
  }
  const date = /^(\d{4})-(\d{2})-(\d{2})[t ](\d{2}):(\d{2})$/.exec(t);
  if (date) {
    const [y, mo, d, h, mi] = date.slice(1).map(Number) as [number, number, number, number, number];
    const ms = Date.UTC(y, mo - 1, d, h, mi);
    if (Number.isNaN(ms) || new Date(ms).getUTCDate() !== d || h > 23 || mi > 59)
      return `"${text}" is not a valid date.`;
    return toUtcMs(ms / 60_000);
  }
  return `I don't understand "${text}": try "now", "in 2h", "18:30" or "2026-12-24 18:00".`;
}
