import type { Tag } from "./contracts.ts";
import type { Context, Member, Channel } from "@cicord/sdk";

const key = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,63}$/;
const list = (v: unknown): string[] | null =>
  Array.isArray(v) &&
  v.length <= 30 &&
  v.every((x) => typeof x === "string" && x.length > 0 && x.length <= 80)
    ? v
    : null;
export function valid(v: unknown): Tag | undefined {
  if (!v || typeof v !== "object") return;
  const t = v as Tag;
  if (
    typeof t.name !== "string" ||
    !key.test(t.name) ||
    typeof t.text !== "string" ||
    !t.text.trim() ||
    t.text.length > 1800 ||
    !list(t.aliases ?? []) ||
    !list(t.keywords ?? []) ||
    (t.channel !== undefined &&
      (typeof t.channel !== "string" || !/^[a-z][a-z0-9-]{0,62}$/.test(t.channel))) ||
    (t.url !== undefined &&
      (typeof t.url !== "string" || !/^https:\/\/[^\s<>]+$/.test(t.url) || t.url.length > 1024))
  )
    return;
  return {
    name: t.name,
    text: t.text,
    aliases: t.aliases ?? [],
    keywords: t.keywords ?? [],
    ...(t.channel ? { channel: t.channel } : {}),
    ...(t.url ? { url: t.url } : {}),
  };
}
const unquote = (s: string) => s.trim().replace(/^(["'])([\s\S]*)\1$/, "$2");
export function parseTag(s: string): Tag | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(s);
  if (!match) return;
  const values: Record<string, unknown> = Object.create(null);
  let last = "";
  for (const line of match[1]!.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const item = /^\s+-\s+(.+)$/.exec(line);
    if (item && Array.isArray(values[last])) {
      (values[last] as string[]).push(unquote(item[1]!));
      continue;
    }
    const field = /^([\w]+):\s*(.*)$/.exec(line);
    if (
      !field ||
      !["name", "aliases", "keywords", "channel", "url"].includes(field[1]!) ||
      field[1]! in values
    )
      return;
    last = field[1]!;
    const raw = field[2]!;
    values[last] =
      last === "keywords" || last === "aliases"
        ? raw
            .replace(/^\[|\]$/g, "")
            .split(",")
            .map(unquote)
            .filter(Boolean)
        : unquote(raw);
  }
  return valid({ ...values, text: match[2]!.trim() });
}
export function visible(ctx: Context, tag: Tag, viewer?: Member, destination?: Channel) {
  if (!tag.channel) return true;
  if (!viewer) return false;
  try {
    return (
      viewer.canView(tag.channel) &&
      (!destination ||
        ["same", "narrower"].includes(ctx.server.compareAudience(tag.channel, destination)))
    );
  } catch {
    return false;
  }
}
export function search(tags: Iterable<Tag>, q: string, limit: number): Tag[] {
  const query = q.toLowerCase().trim(),
    words = query.split(/\s+/).filter(Boolean);
  return [...tags]
    .map((tag) => {
      const labels = [tag.name, ...tag.aliases, ...tag.keywords].map((s) => s.toLowerCase());
      const score = !query
        ? 1
        : labels.includes(query)
          ? 5
          : labels.some((x) => x.startsWith(query))
            ? 4
            : labels.some((x) => x.includes(query))
              ? 3
              : words.filter((w) => labels.some((l) => l.includes(w))).length /
                Math.max(1, words.length);
      return { tag, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.tag.name.localeCompare(b.tag.name))
    .slice(0, limit)
    .map((x) => x.tag);
}
