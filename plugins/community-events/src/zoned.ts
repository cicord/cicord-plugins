import { offsetAt, toUtc } from "./tz.ts";

/** Local wall-clock milliseconds of an instant in a zone (unknown zones are UTC). */
export const localMs = (zone: string, utcMs: number) => utcMs + offsetAt(zone, utcMs) * 60_000;

/** Instant of a local wall-clock millisecond: a skipped time moves forward one hour. */
export function utcMs(zone: string, local: number) {
  const minute = Math.floor(local / 60_000);
  return toUtc(zone, minute) * 60_000 + (local - minute * 60_000);
}

const WEEK = 7 * 86_400_000;
/** Start of a weekly series' occurrence: same local weekday and time as its first one. */
export const weekly = (zone: string, first: number, slot: number) =>
  utcMs(zone, localMs(zone, first) + slot * WEEK);
