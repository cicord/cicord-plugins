import type { Context, Member, Message, PluginConfig } from "@cicord/sdk";
import { staff } from "./data.ts";

export type Rule = "links" | "duplicates" | "mentions" | "newAccounts" | "images" | "automod";
export type Action = PluginConfig["links"]["action"];
export type Ref = { id: string; channel: string; at: number; hint: number; mentions: number };
export const normalize = (text: string) =>
  text.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
export function exempt(ctx: Context, m: Member, channel?: string) {
  return (
    !m.access ||
    staff(m) ||
    m.id === ctx.server.ownerId ||
    m.id === ctx.bot.user.id ||
    ctx.config.exempt.bots.includes(m.id) ||
    ctx.config.exempt.roles.some((role) => m.hasRole(role)) ||
    (!!channel && ctx.config.exempt.channels.includes(channel))
  );
}
export const domain = (value: string) =>
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(
    value,
  ) && value.length <= 253;
export function linksIn(text: string) {
  const output: { host: string; invite?: string }[] = [];
  const matches = text.matchAll(
    /(?:https?:\/\/[^\s<>/\\]+|(?:[a-z\d-]+\.)+[a-z]{2,})(?:[/:][^\s<>]*)?/gi,
  );
  for (const match of matches) {
    const path = match[0]
      .replace(/^https?:\/\//i, "")
      .replace(/\\/g, "/")
      .split(/[/?#]/);
    const authority = path[0]!.split("@").pop()!;
    const host = authority.split(":")[0]!.toLowerCase().replace(/\.$/, "");
    if (!domain(host)) continue;
    const invite = (
      host === "discord.gg"
        ? path[1]
        : ["discord.com", "discordapp.com", "www.discord.com"].includes(host) &&
            path[1] === "invite"
          ? path[2]
          : undefined
    )?.match(/^[\w-]+/)?.[0];
    output.push({ host, invite });
  }
  return output;
}
function includesDomain(host: string, list: string[]) {
  return list.some((raw) => {
    const d = raw.trim().toLowerCase();
    return host === d || host.endsWith("." + d);
  });
}
async function badLink(ctx: Context, links: ReturnType<typeof linksIn>) {
  const config = ctx.config.links;
  const additions = (await ctx.kv.get<string[]>("domains")) ?? [];
  const feeds = (await ctx.kv.get<string[]>("feed")) ?? [];
  let invites: Set<string> | undefined;
  for (const { host, invite } of links) {
    if (invite && config.blockInvites) {
      if (!config.allowOwnInvites) return true;
      if (ctx.features.enabled("invites")) {
        invites ??= new Set((await ctx.server.invites()).map((x) => x.code));
        if (!invites.has(invite)) return true;
        continue;
      }
    }
    if (
      config.blockShorteners &&
      ["bit.ly", "t.co", "tinyurl.com", "is.gd", "cutt.ly"].includes(host)
    )
      return true;
    if (includesDomain(host, [...feeds, ...additions])) return true;
    if (includesDomain(host, config.domains) !== (config.mode === "allowlist")) return true;
  }
  return false;
}
export async function refreshFeeds(ctx: Context) {
  if (!ctx.features.enabled("feeds")) return;
  const values = new Set<string>();
  for (const feed of ctx.config.links.feeds) {
    const response = await ctx.http.fetch(feed.url, { timeoutMs: 2500 });
    if (response.status !== 200) throw new Error("guard feed unavailable");
    const body = await response.text();
    if (body.length > 500000) throw new Error("guard feed exceeds limit");
    const list: unknown = feed.format === "lines" ? body.split(/\r?\n/) : JSON.parse(body);
    if (!Array.isArray(list)) throw new Error("guard feed must contain a domain list");
    for (const item of list)
      if (typeof item === "string" && domain(item.trim())) values.add(item.trim().toLowerCase());
    if (values.size > 5000) throw new Error("guard feed exceeds 5000 domains");
  }
  await ctx.kv.set("feed", [...values], { ttlSeconds: 86400 });
}
export const recently = (date: Date | undefined, ms: number) =>
  !!date &&
  Number.isFinite(date.getTime()) &&
  Date.now() >= date.getTime() &&
  Date.now() - date.getTime() < ms;
export async function inspect(
  ctx: Context,
  message: Message,
  member: Member,
): Promise<{ rule: Rule; refs: Ref[] } | undefined> {
  const text = normalize(message.content),
    links = linksIn(message.content);
  const mentions = message.content.match(/<@(?:!|&)?\d+>|@(?:everyone|here)\b/g)?.length ?? 0;
  // A hint only filters lookups. Before any action, fetch and compare normalized
  // Discord messages so a hash collision cannot implicate the member.
  let hint = 0;
  for (let n = 0; n < text.length; n++) hint = (Math.imul(hint, 31) + text.charCodeAt(n)) | 0;
  const now = Date.now(),
    cfg = ctx.config;
  const key = "history:" + member.id,
    window = Math.max(cfg.duplicates.seconds, cfg.mentions.seconds);
  const history = ((await ctx.kv.get<Ref[]>(key)) ?? []).filter((x) => x.at >= now - window * 1000);
  if (history.some((ref) => ref.id === message.id)) return;
  const ref = { id: message.id, channel: message.channel.id, at: now, hint, mentions };
  await ctx.kv.set(key, [...history.slice(-99), ref], { ttlSeconds: window });
  if (text && cfg.duplicates.enabled) {
    const candidates = history.filter(
      (x) => x.hint === hint && x.at >= now - cfg.duplicates.seconds * 1000,
    );
    if (candidates.length + 1 >= cfg.duplicates.count) {
      const found = [ref];
      for (const old of candidates.slice(-20)) {
        const item = await ctx.server.channel({ id: old.channel }).message(old.id);
        if (item?.author.id === member.id && normalize(item.content) === text) found.push(old);
      }
      if (found.length >= cfg.duplicates.count) return { rule: "duplicates", refs: found };
    }
  }
  if (links.length && (await badLink(ctx, links))) return { rule: "links", refs: [ref] };
  const total = history
    .filter((x) => x.at >= now - cfg.mentions.seconds * 1000)
    .reduce((s, x) => s + x.mentions, mentions);
  if (mentions && (mentions >= cfg.mentions.perMessage || total >= cfg.mentions.perWindow))
    return { rule: "mentions", refs: [ref] };
  if (message.attachments.length && ctx.features.enabled("images")) {
    const hashes = [...cfg.images.hashes, ...((await ctx.kv.get<string[]>("hashes")) ?? [])];
    if (hashes.length)
      for (const a of message.attachments.filter((a) => a.contentType?.startsWith("image/"))) {
        const fingerprint = await ctx.media.hash(a, { algo: "phash" });
        if (hashes.some((h) => ctx.media.distance(fingerprint, h) <= cfg.images.threshold))
          return { rule: "images", refs: [ref] };
      }
  }
  const young =
    recently(member.user.createdAt, cfg.newAccounts.minAccountAgeDays * 86400000) ||
    recently(member.joinedAt, cfg.newAccounts.minMemberMinutes * 60000);
  const restricted = cfg.newAccounts.restrict.some(
    (rule) =>
      ({
        links: !!links.length,
        attachments: !!message.attachments.length,
        mentions: !!mentions,
        invites: links.some((l) => !!l.invite),
      })[rule],
  );
  if (young && restricted) {
    if (ctx.features.enabled("verification") && ctx.plugins.has("verification")) {
      const result = await ctx.plugins.query("verification", "status", { userId: member.id });
      if (
        result &&
        typeof result === "object" &&
        !Array.isArray(result) &&
        result.verified === true
      )
        return;
    }
    return { rule: "newAccounts", refs: [ref] };
  }
}
