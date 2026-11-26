// Types for the independent verifier (verify.mjs), used by the TypeScript tests.
export type VerifyInput = {
  seed: string;
  id: string;
  entries: { userId: string; weight: number }[];
  count: number;
  previous?: string[];
};
export function verify(input: VerifyInput): {
  commitment: string;
  entrantsHash: string;
  winners: string[];
};
export type Entry = { userId: string; weight: number };
/** Every entrant page of a draw route, following `entriesCursor` to the last page. */
export function fetchDraw(
  url: string | URL,
  options?: { fetch?: typeof globalThis.fetch; headers?: Record<string, string> },
): Promise<Record<string, unknown> & { entries: Entry[] }>;
