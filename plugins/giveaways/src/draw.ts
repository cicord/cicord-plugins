import sha, { hmac } from "./fast-sha256/sha256.cjs";

export type Entry = { userId: string; weight: number };
export const hex = (bytes: Uint8Array): string =>
  [...bytes].map((n) => n.toString(16).padStart(2, "0")).join("");
const ascii = (value: string) => Uint8Array.from(value, (char) => char.charCodeAt(0));

export function seedBytes(value: string): Uint8Array {
  if (!/^[a-f0-9]{64}$/i.test(value)) throw new Error("Expected a 32-byte hexadecimal seed");
  return Uint8Array.from(value.match(/../g)!, (byte) => parseInt(byte, 16));
}
export const commitment = (seed: string) => hex(sha(seedBytes(seed)));
export function canonical(entries: Entry[]): Entry[] {
  const ids = new Set<string>();
  for (const { userId, weight } of entries) {
    if (
      !/^[1-9][0-9]{0,19}$/.test(userId) ||
      !Number.isSafeInteger(weight) ||
      weight < 1 ||
      ids.has(userId)
    )
      throw new Error("Invalid entrant or weight");
    ids.add(userId);
  }
  return entries.toSorted(
    (a, b) => a.userId.length - b.userId.length || (a.userId < b.userId ? -1 : 1),
  );
}
export const entrantsHash = (entries: Entry[]) =>
  hex(
    sha(
      ascii(
        canonical(entries)
          .map((e) => `${e.userId}:${e.weight}\n`)
          .join(""),
      ),
    ),
  );

export function draw(
  seed: string,
  giveawayId: string,
  entries: Entry[],
  previous: string[],
  count: number,
): string[] {
  const remaining = canonical(entries).filter((e) => !previous.includes(e.userId));
  const key = seedBytes(seed);
  const result: string[] = [];
  const range = 1n << 64n;
  while (remaining.length && result.length < count) {
    const k = previous.length + result.length;
    const weight = remaining.reduce((w, e) => w + BigInt(e.weight), 0n);
    const cutoff = range - (range % weight);
    let value: bigint;
    let attempt = 0;
    do {
      const mac = hmac(key, ascii(`gw-draw-v1:${giveawayId}:${k}:${attempt++}`));
      value = new DataView(mac.buffer, mac.byteOffset, 8).getBigUint64(0, false);
    } while (value >= cutoff);
    let target = value % weight;
    const index = remaining.findIndex((e) => (target -= BigInt(e.weight)) < 0n);
    result.push(remaining.splice(index, 1)[0]!.userId);
  }
  return result;
}
