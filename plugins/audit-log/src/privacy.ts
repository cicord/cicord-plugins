import type { Context, Json } from "@cicord/sdk";
import { eraseSubject, repairRow, type Row } from "./log.ts";

export async function privacy(ctx: Context, user: string, erase: boolean) {
  let erased = 0;
  const records: { at?: number; category: string; relation?: string }[] = [];
  const alias = erase ? await ctx.privacy.pseudonym(user) : undefined;
  for (const prefix of ["repair:", "row:", "seen:", "proof:", "pending:", "matched:", "q:"]) {
    let cursor: string | undefined;
    do {
      const page = await ctx.kv.list({ prefix, limit: 100, cursor });
      for (const { key, value } of page.items) {
        if (!value || Array.isArray(value) || typeof value !== "object") continue;
        if (prefix === "repair:") {
          if (erase && value["alias"] === alias) {
            const row = await ctx.kv.get<Row>("row:" + key.slice(7));
            if (row) await repairRow(ctx, row);
            else await ctx.kv.delete(key);
          }
          continue;
        }
        if (prefix === "row:") {
          const r = value as Row;
          if (!r.subjects.includes(user)) continue;
          if (erase) {
            await eraseSubject(ctx, r, user);
            erased++;
          } else if (!r.erasing && r.until > Date.now())
            records.push({ at: r.at, category: r.category });
        } else if (
          value["author"] === user ||
          value["actor"] === user ||
          (prefix === "q:" && typeof value["text"] === "string" && value["text"].includes(user)) ||
          (typeof value["content"] === "string" && value["content"].includes(user))
        ) {
          if (!erase)
            records.push({
              category: prefix.slice(0, -1),
              relation: value["actor"] === user ? "actor" : "subject",
              ...(typeof value["at"] === "number" ? { at: value["at"] } : {}),
            });
          if (erase) {
            await ctx.kv.delete(key);
            erased++;
          }
        }
      }
      cursor = page.cursor;
    } while (cursor);
  }
  return { erased, records: records as Json };
}
