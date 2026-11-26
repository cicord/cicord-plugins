import { defineRoutes, type Context, type Member } from "@cicord/sdk";
import { feature, visible, type Row } from "./log.ts";
import type { Routes, SearchResult } from "./routes.ts";

type Filter = { q?: string; member?: string; channel?: string; category?: string; cursor?: string };
async function search(
  ctx: Context,
  member: Member | undefined,
  f: Filter,
  exportPage = false,
): Promise<SearchResult> {
  if (!ctx.config.enabled || !member) return { items: [] };
  const q = (f.q ?? "").trim().slice(0, 160),
    subject = (f.member ?? "").slice(0, 64),
    category = (f.category ?? "").slice(0, 64);
  const tags = [...(subject ? ["member-" + subject] : []), ...(category ? [category] : [])];
  let rows: (Row | undefined)[] = [],
    cursor: string | undefined;
  let indexed = false;
  if (!exportPage && feature(ctx, "search") && q) {
    try {
      const hits = await ctx.index("observations").search(q, { limit: 50, tags });
      rows = await ctx.kv.getMany<Row>(hits.map((h) => "row:" + h.id));
      indexed = true;
    } catch {
      ctx.status.set(
        "index",
        "Full-text search is unavailable. Showing a page of matching stored observations.",
      );
    }
  }
  if (!indexed) {
    const after = f.cursor?.startsWith("row:") ? f.cursor : undefined;
    const page = await ctx.kv.list<Row>({ prefix: "row:", limit: 50, cursor: after });
    rows = page.items.map((x) => x.value);
    cursor = page.cursor;
  }
  const withheld = await ctx.kv.getMany(rows.map((r) => "repair:" + (r?.id ?? "missing")));
  const items = rows
    .filter((_, i) => withheld[i] === undefined)
    .filter(
      (r): r is Row =>
        !!r &&
        visible(ctx, r, member) &&
        (!category || r.category === category) &&
        (!subject || r.subjects.includes(subject)) &&
        (!f.channel || r.sources.includes(f.channel)),
    )
    .filter((r) => {
      if (!q) return true;
      const textAllowed =
        ctx.config.cacheContent &&
        feature(ctx, "cacheContent") &&
        r.contentUntil !== undefined &&
        r.contentUntil > Date.now();
      if (indexed && (!r.excerpt || textAllowed)) return true;
      return [r.text, textAllowed ? (r.excerpt ?? "") : "", r.category]
        .join(" ")
        .toLowerCase()
        .includes(q.toLowerCase());
    })
    .map((r) => ({
      id: r.id,
      at: r.at,
      category: r.category,
      text: r.text,
      ...(r.excerpt &&
      r.contentUntil &&
      r.contentUntil > Date.now() &&
      ctx.config.cacheContent &&
      feature(ctx, "cacheContent")
        ? { excerpt: r.excerpt }
        : {}),
    }));
  return { items, ...(cursor ? { cursor } : {}) };
}
export const routes = defineRoutes<Routes>({
  "GET /search": {
    access: "moderator",
    handler: (ctx, req) => search(ctx, req.viewer?.member, req.query),
  },
  "GET /export": {
    access: "moderator",
    handler: (ctx, req) => search(ctx, req.viewer?.member, req.query, true),
  },
});
