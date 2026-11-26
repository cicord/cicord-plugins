import type { Context } from "@cicord/sdk";
import type { Tag } from "./contracts.ts";
import { parseTag, valid } from "./catalog.ts";

export const PORTAL_LIMIT = 1000;
export const lower = (s: string) => s.trim().toLowerCase();
export const portalKey = (name: string) => "portal:" + lower(name);

export type Catalog = {
  /** File-backed tags by lowercase name. They take precedence over portal tags. */
  files: Map<string, Tag>;
  /** Portal tags by lowercase name, as stored in KV. */
  portal: Map<string, Tag>;
  all: Tag[];
};

/**
 * Reads the bound `tags/**\/*.md` files. Each invocation may run in a fresh JS realm that
 * never ran onStart (provider queries, and member handlers in the future), so nothing here
 * relies on startup state. `strict` reports the first invalid file or duplicate name; the
 * lenient form skips them, keeping the first file by sorted path.
 */
export async function readFileTags(ctx: Context, strict = false): Promise<Map<string, Tag>> {
  const out = new Map<string, Tag>();
  if (!ctx.config.enabled || !ctx.features.enabled("files")) return out;
  const paths = [...(await ctx.files.list("tags/**/*.md"))].sort();
  for (let i = 0; i < paths.length; i += 32) {
    const batch = await Promise.all(
      paths.slice(i, i + 32).map(async (path) => [path, parseTag(await ctx.files.read(path))] as const),
    );
    for (const [path, tag] of batch) {
      if (!tag) {
        if (strict) throw new Error("Invalid tag frontmatter in " + path);
        continue;
      }
      if (out.has(lower(tag.name))) {
        if (strict) throw new Error("Duplicate tag name: " + tag.name);
        continue;
      }
      out.set(lower(tag.name), tag);
    }
  }
  return out;
}

// Instance files are fixed for the lifetime of a runtime VM (a revision starts a new one),
// so the parsed file catalog can be memoized per context. Portal tags are never cached:
// they change through routes and must be read from KV on every invocation.
const fileMemo = new WeakMap<object, Promise<Map<string, Tag>>>();
function fileTags(ctx: Context) {
  let memo = fileMemo.get(ctx);
  if (!memo) {
    memo = readFileTags(ctx);
    fileMemo.set(ctx, memo);
    memo.catch(() => fileMemo.delete(ctx));
  }
  return memo;
}

/** Bounded read of the portal tags: at most PORTAL_LIMIT entries, in pages of 100. */
export async function portalTags(ctx: Context): Promise<Map<string, Tag>> {
  const out = new Map<string, Tag>();
  let cursor: string | undefined;
  do {
    const page = await ctx.kv.list<Tag>({ prefix: "portal:", limit: 100, cursor });
    for (const item of page.items) {
      const tag = valid(item.value);
      if (tag && out.size < PORTAL_LIMIT) out.set(lower(tag.name), tag);
    }
    cursor = page.cursor;
  } while (cursor && out.size < PORTAL_LIMIT);
  return out;
}

/** The current catalog, rebuilt from instance files and KV. Read-only: safe in a query frame. */
export async function loadCatalog(ctx: Context): Promise<Catalog> {
  if (!ctx.config.enabled) return { files: new Map(), portal: new Map(), all: [] };
  const [files, portal] = await Promise.all([fileTags(ctx), portalTags(ctx)]);
  return {
    files,
    portal,
    all: [...files.values(), ...[...portal].filter(([k]) => !files.has(k)).map(([, t]) => t)],
  };
}
