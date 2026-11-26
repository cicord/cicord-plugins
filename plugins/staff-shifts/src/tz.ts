/**
 * Time zones without Intl: the plugin host has no time zone database, so the plugin carries
 * the standard offset and the daylight saving rule of common zones. "Local minutes" are
 * minutes since 1970-01-01T00:00 of the zone's wall clock (read with the UTC getters of
 * `new Date(local * 60_000)`).
 */

type Rule = "none" | "eu" | "us" | "au" | "nz";

/** Zone → [standard offset in minutes, DST rule]. Keep in sync with config.schema.json. */
export const ZONES: Record<string, readonly [number, Rule]> = {
  UTC: [0, "none"],
  "Europe/London": [0, "eu"],
  "Europe/Dublin": [0, "eu"],
  "Europe/Lisbon": [0, "eu"],
  "Europe/Paris": [60, "eu"],
  "Europe/Brussels": [60, "eu"],
  "Europe/Amsterdam": [60, "eu"],
  "Europe/Luxembourg": [60, "eu"],
  "Europe/Berlin": [60, "eu"],
  "Europe/Zurich": [60, "eu"],
  "Europe/Vienna": [60, "eu"],
  "Europe/Madrid": [60, "eu"],
  "Europe/Rome": [60, "eu"],
  "Europe/Stockholm": [60, "eu"],
  "Europe/Oslo": [60, "eu"],
  "Europe/Copenhagen": [60, "eu"],
  "Europe/Warsaw": [60, "eu"],
  "Europe/Prague": [60, "eu"],
  "Europe/Budapest": [60, "eu"],
  "Europe/Athens": [120, "eu"],
  "Europe/Helsinki": [120, "eu"],
  "Europe/Kyiv": [120, "eu"],
  "Europe/Bucharest": [120, "eu"],
  "Europe/Istanbul": [180, "none"],
  "Europe/Moscow": [180, "none"],
  "Africa/Algiers": [60, "none"],
  "Africa/Tunis": [60, "none"],
  "Africa/Lagos": [60, "none"],
  "Africa/Dakar": [0, "none"],
  "Africa/Abidjan": [0, "none"],
  "Africa/Johannesburg": [120, "none"],
  "Africa/Nairobi": [180, "none"],
  "Asia/Dubai": [240, "none"],
  "Asia/Karachi": [300, "none"],
  "Asia/Kolkata": [330, "none"],
  "Asia/Dhaka": [360, "none"],
  "Asia/Bangkok": [420, "none"],
  "Asia/Jakarta": [420, "none"],
  "Asia/Ho_Chi_Minh": [420, "none"],
  "Asia/Singapore": [480, "none"],
  "Asia/Shanghai": [480, "none"],
  "Asia/Hong_Kong": [480, "none"],
  "Asia/Manila": [480, "none"],
  "Asia/Seoul": [540, "none"],
  "Asia/Tokyo": [540, "none"],
  "Australia/Perth": [480, "none"],
  "Australia/Brisbane": [600, "none"],
  "Australia/Adelaide": [570, "au"],
  "Australia/Sydney": [600, "au"],
  "Australia/Melbourne": [600, "au"],
  "Pacific/Auckland": [720, "nz"],
  "Pacific/Noumea": [660, "none"],
  "Pacific/Tahiti": [-600, "none"],
  "Pacific/Honolulu": [-600, "none"],
  "America/Anchorage": [-540, "us"],
  "America/Los_Angeles": [-480, "us"],
  "America/Vancouver": [-480, "us"],
  "America/Phoenix": [-420, "none"],
  "America/Denver": [-420, "us"],
  "America/Chicago": [-360, "us"],
  "America/Mexico_City": [-360, "none"],
  "America/New_York": [-300, "us"],
  "America/Toronto": [-300, "us"],
  "America/Montreal": [-300, "us"],
  "America/Bogota": [-300, "none"],
  "America/Lima": [-300, "none"],
  "America/Halifax": [-240, "us"],
  "America/Martinique": [-240, "none"],
  "America/Guadeloupe": [-240, "none"],
  "America/St_Johns": [-210, "us"],
  "America/Sao_Paulo": [-180, "none"],
  "America/Argentina/Buenos_Aires": [-180, "none"],
  "Indian/Reunion": [240, "none"],
};

const HOUR = 3_600_000;
const DAY = 86_400_000;

/** 00:00 UTC of the n-th Sunday (1-based) of a month; n = -1 for the last one. */
function sunday(year: number, month: number, n: number): number {
  if (n > 0) {
    const first = Date.UTC(year, month, 1);
    const dow = new Date(first).getUTCDay();
    return first + (((7 - dow) % 7) + (n - 1) * 7) * DAY;
  }
  const last = Date.UTC(year, month + 1, 0);
  return last - new Date(last).getUTCDay() * DAY;
}

const cache = new Map<string, [number, number]>();

/** DST [start, end) instants (UTC ms) of a rule for a year (southern rules: end < start). */
function transitions(rule: Exclude<Rule, "none">, std: number, year: number): [number, number] {
  const key = `${rule}:${std}:${year}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const stdMs = std * 60_000;
  const dstMs = stdMs + HOUR;
  let t: [number, number];
  switch (rule) {
    case "eu": // last Sunday of March / October, 01:00 UTC
      t = [sunday(year, 2, -1) + HOUR, sunday(year, 9, -1) + HOUR];
      break;
    case "us": // second Sunday of March 02:00 standard / first Sunday of November 02:00 daylight
      t = [sunday(year, 2, 2) + 2 * HOUR - stdMs, sunday(year, 10, 1) + 2 * HOUR - dstMs];
      break;
    case "au": // first Sunday of October 02:00 standard / first Sunday of April 03:00 daylight
      t = [sunday(year, 9, 1) + 2 * HOUR - stdMs, sunday(year, 3, 1) + 3 * HOUR - dstMs];
      break;
    case "nz": // last Sunday of September 02:00 standard / first Sunday of April 03:00 daylight
      t = [sunday(year, 8, -1) + 2 * HOUR - stdMs, sunday(year, 3, 1) + 3 * HOUR - dstMs];
      break;
  }
  cache.set(key, t);
  return t;
}

/** UTC offset of a zone at an instant, in minutes. Unknown zones are UTC. */
export function offsetAt(zone: string, utcMs: number): number {
  const z = ZONES[zone];
  if (!z) return 0;
  const [std, rule] = z;
  if (rule === "none") return std;
  const [start, end] = transitions(rule, std, new Date(utcMs + std * 60_000).getUTCFullYear());
  const dst = start < end ? utcMs >= start && utcMs < end : utcMs >= start || utcMs < end;
  return dst ? std + 60 : std;
}

/** Local minute of a UTC minute. */
export function toLocal(zone: string, utcMinute: number): number {
  return utcMinute + offsetAt(zone, utcMinute * 60_000);
}

/**
 * UTC minute of a local minute. A local time skipped by DST maps to the instant one hour
 * later; a repeated one to its first occurrence.
 */
export function toUtc(zone: string, localMinute: number): number {
  const z = ZONES[zone];
  if (!z) return localMinute;
  const std = z[0];
  const first = localMinute - offsetAt(zone, (localMinute - std - 60) * 60_000);
  if (toLocal(zone, first) === localMinute) return first;
  const second = localMinute - offsetAt(zone, (localMinute - std) * 60_000);
  if (toLocal(zone, second) === localMinute) return second;
  return localMinute - std; // in a DST gap
}

/** Parses "YYYY-MM-DD HH:MM" (or with a T) as local minutes, or undefined. */
export function parseLocal(text: string): number | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/.exec(text.trim());
  if (!m) return undefined;
  const [y, mo, d, h, mi] = m.slice(1).map(Number) as [number, number, number, number, number];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return undefined;
  const ms = Date.UTC(y, mo - 1, d, h, mi);
  const back = new Date(ms);
  if (back.getUTCDate() !== d) return undefined; // e.g. February 30
  return ms / 60_000;
}

/** Local minutes as "YYYY-MM-DD HH:MM". */
export function formatLocal(localMinute: number): string {
  return new Date(localMinute * 60_000).toISOString().slice(0, 16).replace("T", " ");
}
