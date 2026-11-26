import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// Independent implementation for operators. All inputs are the published JSON fields.
export function verify({ seed, id, entries, count, previous = [] }) {
  const sorted = entries.toSorted((a, b) => (BigInt(a.userId) < BigInt(b.userId) ? -1 : 1));
  const key = Buffer.from(seed, "hex");
  const sha = (value) => createHash("sha256").update(value).digest("hex");
  const entrantsHash = sha(
    sorted.map(({ userId, weight }) => userId + ":" + weight + "\n").join(""),
  );
  const pool = sorted.filter((e) => !previous.includes(e.userId));
  const winners = [];
  for (let k = previous.length; k < count + previous.length && pool.length; k++) {
    const sum = pool.reduce((s, e) => s + BigInt(e.weight), 0n);
    for (let j = 0; ; j++) {
      const r = createHmac("sha256", key)
        .update(["gw-draw-v1", id, k, j].join(":"))
        .digest()
        .readBigUInt64BE();
      if (r >= (2n ** 64n / sum) * sum) continue;
      let cursor = 0n;
      const index = pool.findIndex((e) => (cursor += BigInt(e.weight)) > r % sum);
      winners.push(pool.splice(index, 1)[0].userId);
      break;
    }
  }
  return { commitment: sha(key), entrantsHash, winners };
}
/**
 * Reads every page of a draw's entrants: `GET /giveaways/:id` (publishEntrants) or the
 * moderator route `GET /giveaways/:id/entries`. Each page holds at most 1,000 entries; the
 * next one is fetched with `?cursor=<entriesCursor>` until the cursor is absent. Returns the
 * first page's fields with `entries` holding the whole list.
 */
export async function fetchDraw(url, { fetch = globalThis.fetch, headers } = {}) {
  let first,
    cursor;
  const entries = [],
    seen = new Set();
  do {
    const page = new URL(url);
    if (cursor) page.searchParams.set("cursor", cursor);
    const response = await fetch(page, headers ? { headers } : {});
    if (!response.ok) throw new Error(page + ": HTTP " + response.status);
    const body = await response.json();
    if (!Array.isArray(body.entries))
      throw new Error(
        page + ": no entrant list (publishEntrants is off: use the moderator route /entries)",
      );
    first ??= body;
    entries.push(...body.entries);
    cursor = body.entriesCursor;
    if (cursor !== undefined && (typeof cursor !== "string" || seen.has(cursor)))
      throw new Error(page + ": invalid or repeated entriesCursor");
    seen.add(cursor);
  } while (cursor);
  if (new Set(entries.map((e) => e.userId)).size !== entries.length)
    throw new Error(url + ": an entrant appears on two pages");
  const { entriesCursor: _last, ...fields } = first;
  return { ...fields, entries };
}

/**
 * CLI. `node verify.mjs input.json`: verifies the given fields. `input.json` may give `url`
 * (a draw route, optionally with `headers`) instead of `entries`: every page is fetched.
 * `node verify.mjs <draw URL> [count] [previous,winner,ids]`: fetches the draw and every
 * entrant page, then checks the entrants hash and the winners. `count` defaults to the
 * number of winners shown; give `previous` (the earlier winners) for a redraw.
 */
async function main([arg, count, previous]) {
  let input;
  // A portal session token for the moderator route `/entries` (Authorization: Bearer).
  const token = process.env.CICORD_PORTAL_TOKEN;
  const headers = token ? { authorization: "Bearer " + token } : undefined;
  if (/^https?:\/\//.test(arg ?? "")) {
    const draw = await fetchDraw(arg, { headers });
    input = {
      ...draw,
      count: count ? Number(count) : draw.winners.length,
      previous: previous ? previous.split(",") : [],
    };
  } else {
    input = JSON.parse(readFileSync(arg, "utf8"));
    if (!input.entries && input.url)
      input = { ...input, entries: (await fetchDraw(input.url, input)).entries };
  }
  const result = verify(input);
  if (input.entrantsHash !== undefined)
    result.entrantsHashMatches = result.entrantsHash === input.entrantsHash;
  if (input.commitment !== undefined)
    result.commitmentMatches = result.commitment === input.commitment;
  if (Array.isArray(input.winners))
    result.winnersMatch =
      JSON.stringify(result.winners) === JSON.stringify(input.winners.slice(-result.winners.length));
  console.log(JSON.stringify(result, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main(process.argv.slice(2));
