import type { Context, Embed, MessagePayload, PluginConfig } from "@cicord/sdk";
import type { Release } from "./github.ts";

export type Feed = NonNullable<PluginConfig["feeds"]>[number];

/** Discord's embed limits (the whole embed must stay under 6000 characters). */
export const TITLE_LIMIT = 256;
export const DESCRIPTION_LIMIT = 4096;
const AUTHOR_LIMIT = 256;

/** Cuts `s` to at most `max` UTF-16 units without splitting a surrogate pair. */
function cut(s: string, max: number): string {
  if (s.length <= max) return s;
  let out = s.slice(0, max);
  const last = out.charCodeAt(out.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  return out;
}

const oneLine = (s: string, max: number): string => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${cut(flat, max - 1)}…`;
};

/**
 * The release notes, trimmed to `limit` with a link to the full notes when cut: the cut is
 * made at a line break when there is one near the end, and an open code block is closed.
 */
export function trimNotes(
  body: string,
  url: string,
  limit = DESCRIPTION_LIMIT,
  readMore = "Read the full notes",
): string {
  if (body.length <= limit) return body;
  const more = url ? `\n\n… [${readMore}](${url})` : "\n\n…";
  const fence = "\n```";
  let text = cut(body, limit - more.length - fence.length);
  const nl = text.lastIndexOf("\n");
  if (nl > text.length - 500 && nl > 0) text = text.slice(0, nl);
  text = text.trimEnd();
  if ((text.match(/```/g)?.length ?? 0) % 2 === 1) text += fence;
  return text + more;
}

export const displayName = (feed: Feed): string => feed.label ?? feed.repo;

/** The announcement embed of a release. */
export function releaseEmbed(ctx: Context, feed: Feed, r: Release): Embed {
  const heading = r.name && r.name !== r.tag ? `**${oneLine(r.name, 200)}**\n\n` : "";
  const notes = r.body
    ? trimNotes(r.body, r.url, DESCRIPTION_LIMIT - heading.length, ctx.i18n.t("readMore"))
    : "";
  const description = heading + notes;
  return {
    title: oneLine(`${displayName(feed)} ${r.tag}`, TITLE_LIMIT),
    ...(r.url ? { url: r.url } : {}),
    ...(description ? { description } : {}),
    color: ctx.config.color,
    ...(r.author
      ? {
          author: {
            name: oneLine(r.author.login, AUTHOR_LIMIT),
            ...(r.author.url ? { url: r.author.url } : {}),
            ...(r.author.avatarUrl ? { iconUrl: r.author.avatarUrl } : {}),
          },
        }
      : {}),
    ...(r.prerelease
      ? {
          fields: [{ name: ctx.i18n.t("prerelease"), value: ctx.i18n.t("unstable"), inline: true }],
        }
      : {}),
    footer: { text: feed.repo },
    timestamp: r.publishedAt,
  };
}

/**
 * The announcement: the embed, and the feed's role in the content. Only that role can ping:
 * the notes are in the embed (never pings) and the content holds nothing else.
 */
export function announcement(ctx: Context, feed: Feed, r: Release): MessagePayload {
  let mention = "";
  if (feed.mentionRole) {
    try {
      mention = ctx.server.role(feed.mentionRole).mention;
    } catch {
      ctx.log.warn("github-releases: mentionRole not found, posting without the ping", {
        repo: feed.repo,
        role: feed.mentionRole,
      });
    }
  }
  return {
    ...(mention ? { content: mention } : {}),
    embeds: [releaseEmbed(ctx, feed, r)],
    allowedMentions: { users: false, roles: mention !== "", everyone: false },
  };
}
