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
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  console.log(JSON.stringify(verify(JSON.parse(readFileSync(process.argv[2], "utf8"))), null, 2));
