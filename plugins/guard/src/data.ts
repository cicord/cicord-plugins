import type { Context, Json, Member } from "@cicord/sdk";

export const MONTH = 30 * 86400;
export const staff = (member?: Member) =>
  member?.access === "moderator" || member?.access === "admin";
export const tr = (ctx: Context, key: string) => ctx.i18n.t(key);
export const object = (value: Json | undefined): Record<string, Json> =>
  value && typeof value === "object" && !Array.isArray(value) ? value : {};

export async function rows<T extends Json>(ctx: Context, prefix: string, limit = Infinity) {
  const result: { key: string; value: T }[] = [];
  let cursor: string | undefined;
  do {
    const page = await ctx.kv.list<T>({
      prefix,
      cursor,
      limit: Math.min(100, limit - result.length),
    });
    result.push(...page.items);
    cursor = page.cursor;
  } while (cursor && result.length < limit);
  return result;
}

/**
 * A short-lived per-key claim keeps concurrent handlers in their own runtime
 * invocation and transaction context. A crashed instance releases by expiry.
 */
export async function serial<T>(ctx: Context, subject: string, work: () => Promise<T>): Promise<T> {
  const key = "lock:" + subject;
  const owner = crypto.randomUUID();
  for (let attempt = 0; attempt < 40; attempt++) {
    const claim = await ctx.kv
      .atomic()
      .check(key, null)
      .set(key, owner, { ttlSeconds: 60 })
      .commit();
    if (claim.ok) {
      try {
        return await work();
      } finally {
        const current = await ctx.kv.getEntry(key);
        if (current?.value === owner)
          await ctx.kv.atomic().check(key, current.version).delete(key).commit();
      }
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 15 + Math.floor(Math.random() * 30)));
  }
  throw new Error("Another operation for this record is still processing. Retry shortly.");
}
