import type { Channel, Context, Member } from "@cicord/sdk";

export type Passage = {
  title: string;
  text: string;
  url: string;
  channel?: string;
  path?: string;
  section?: number;
  forum?: string;
  thread?: string;
};
export function sections(raw: string, path: string, base: string): Passage[] {
  const header = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(raw);
  let channel: string | undefined,
    title = path.split("/").at(-1)!.replace(/\.md$/i, "");
  if (header) {
    for (const line of header[1]!.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const field = /^(title|channel):\s*([^\n]+)$/.exec(line);
      // An unrecognised access declaration must never make a document public.
      if (!field) return [];
      if (field[1] === "channel") {
        channel = field[2]!.trim();
        if (!/^[a-z][a-z0-9-]{0,62}$/.test(channel)) return [];
      } else title = field[2]!.trim();
    }
  }
  const url = base.replace(/\/?$/, "/") + path.split("/").map(encodeURIComponent).join("/");
  const chunks: Passage[] = [];
  let heading = title;
  for (const section of raw.slice(header?.[0].length ?? 0).split(/(?=^#{1,6}\s)/m)) {
    const h = /^#{1,6}\s+([^\n]+)\n?/.exec(section);
    if (h) heading = h[1]!.trim();
    const body = section.slice(h?.[0].length ?? 0).trim();
    for (let start = 0; start < body.length; start += 1600) {
      const text = body.slice(start, start + 1600).trim();
      if (text)
        chunks.push({
          title: heading,
          text,
          url,
          path,
          section: chunks.length,
          ...(channel ? { channel } : {}),
        });
    }
  }
  return chunks;
}
export function visible(ctx: Context, p: Passage, user: Member, destination?: Channel): boolean {
  if (!p.channel) return true;
  try {
    const ref = p.thread ? { id: p.thread } : p.channel;
    return (
      user.canView(ref) &&
      (!destination || ["narrower", "same"].includes(ctx.server.compareAudience(ref, destination)))
    );
  } catch {
    return false;
  }
}
// Only a verbatim passage may leave this plugin. The provider selects evidence;
// it cannot create a link, mention, instruction or assertion in the published answer.
export function selectEvidence(raw: unknown, sources: Passage[]): Passage | undefined {
  if (!raw || typeof raw !== "object") return;
  const v = raw as { source?: unknown; quote?: unknown };
  if (
    !Number.isInteger(v.source) ||
    typeof v.quote !== "string" ||
    v.quote.trim().length < 8 ||
    v.quote.length > 1000
  )
    return;
  const source = sources[Number(v.source)];
  if (!source || !source.text.includes(v.quote)) return;
  return { ...source, text: v.quote };
}
export async function searchKnowledge(
  ctx: Context,
  question: string,
  user: Member,
  dest?: Channel,
): Promise<Passage[]> {
  const hits = (
      await Promise.all([
        ctx.index("knowledge").search(question, { limit: 40 }),
        ctx.index("solved").search(question, { limit: 40 }),
      ])
    )
      .flat()
      .sort((a, b) => b.score - a.score),
    out: Passage[] = [];
  const current = new Set(await ctx.files.list("knowledge/**/*.md"));
  for (const hit of hits) {
    if (hit.score < ctx.config.minRelevance) continue;
    const meta = hit.meta as Partial<Passage> | null;
    if (!meta) continue;
    let p: Passage | undefined;
    if (meta.path && current.has(meta.path) && typeof meta.section === "number") {
      p = sections(await ctx.files.read(meta.path), meta.path, ctx.config.documentBaseURL!)[
        meta.section
      ];
    } else if (meta.forum && meta.channel) {
      // Re-read the original in case it was deleted or edited since indexing.
      if (!ctx.config.solvedForums?.includes(meta.channel) || !user.canView(meta.channel)) continue;
      try {
        const ch = ctx.server.channel(meta.thread ? { id: meta.thread } : meta.channel);
        if (!user.canView(ch)) continue;
        const msg = await ch.message(meta.forum);
        if (!msg || (await ctx.kv.get("opt:" + msg.author.id))) continue;
        p = {
          title: ch.name,
          text: msg.content.slice(0, 1600),
          url: "https://discord.com/channels/" + ctx.server.id + "/" + ch.id + "/" + msg.id,
          channel: meta.channel,
          forum: msg.id,
          ...(meta.thread ? { thread: meta.thread } : {}),
        };
      } catch {
        continue;
      }
    }
    if (p && visible(ctx, p, user, dest)) out.push(p);
    if (out.length >= 5) break;
  }
  if (ctx.features.enabled("tags") && ctx.plugins.has("tags")) {
    try {
      const response = (await ctx.plugins.query("tags", "search", {
        query: question,
        limit: 3,
      })) as { entries: { name: string; text: string; url?: string; channel?: string }[] };
      for (const t of response.entries) {
        if (!t.url || !/^https:\/\/[^\s<>]+$/.test(t.url)) continue;
        const p = {
          title: t.name,
          text: t.text.slice(0, 1600),
          url: t.url,
          ...(t.channel ? { channel: t.channel } : {}),
        };
        if (visible(ctx, p, user, dest)) out.push(p);
      }
    } catch {
      ctx.status.set("tags", "Tag search is unavailable");
    }
  }
  return out.slice(0, 6);
}
