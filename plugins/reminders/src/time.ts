import { offsetAt, parseLocal, toLocal, toUtc } from "./tz.ts";

export function duration(text: string): number | undefined {
  const m = /^(\d+)\s*(m|min|h|d|j|w|s(?:emaine)?)$/i.exec(text.trim());
  if (!m) return;
  const units: Record<string, number> = {
    m: 1,
    min: 1,
    h: 60,
    d: 1440,
    j: 1440,
    w: 10080,
    s: 10080,
    semaine: 10080,
  };
  const ms = Number(m[1]) * units[m[2]!.toLowerCase()]! * 60000;
  return Number.isSafeInteger(ms) && ms > 0 ? ms : undefined;
}

export function parseDate(text: string, zone: string, now = Date.now()): number | undefined {
  const delay = duration(text);
  if (delay) return now + delay;
  const tomorrow = /^(?:tomorrow|demain)\s+(\d{1,2})(?:[:h](\d{2})?)?\s*(am|pm)?$/i.exec(
    text.trim(),
  );
  let local = parseLocal(text);
  if (tomorrow) {
    const hour = Number(tomorrow[1]),
      minute = Number(tomorrow[2] ?? 0);
    if (minute > 59 || hour > 23 || (tomorrow[3] && (hour > 12 || hour < 1))) return;
    const h = tomorrow[3] ? (hour % 12) + (/pm/i.test(tomorrow[3]) ? 12 : 0) : hour;
    local =
      (Math.floor(toLocal(zone, Math.floor(now / 60000)) / 1440) + 1) * 1440 + h * 60 + minute;
  }
  return local === undefined ? undefined : toUtc(zone, local) * 60000;
}

const DAY = 86_400_000;

/** Local wall-clock milliseconds of an instant in a zone. */
export const localMs = (zone: string, utcMs: number) => utcMs + offsetAt(zone, utcMs) * 60_000;
/** Instant of a local wall-clock millisecond (DST gaps move forward, repeats take the first). */
function utcMs(zone: string, local: number) {
  const minute = Math.floor(local / 60_000);
  return toUtc(zone, minute) * 60_000 + (local - minute * 60_000);
}

/** What `nextDue` needs from a reminder. `anchor` is the local time of its first occurrence. */
export type Recurrence = { due: number; repeat: number; zone?: string; anchor?: number };

/**
 * The first occurrence after both `now` and the current one. A whole number of days repeats
 * at the same wall-clock time in the reminder's zone, across daylight-saving changes; a
 * shorter interval (such as 2h) is an elapsed duration. Missed occurrences are skipped.
 */
export function nextDue(r: Recurrence, now: number): number {
  const after = Math.max(now, r.due);
  if (!r.zone || r.repeat % DAY !== 0)
    return r.due + (1 + Math.floor((after - r.due) / r.repeat)) * r.repeat;
  const zone = r.zone,
    anchor = r.anchor ?? localMs(zone, r.due);
  // Start one period early: the zone's offset can differ by an hour from the anchor's.
  let k = Math.max(1, Math.floor((localMs(zone, after) - anchor) / r.repeat) - 1);
  let due = utcMs(zone, anchor + k * r.repeat);
  while (due <= after) due = utcMs(zone, anchor + ++k * r.repeat);
  return due;
}
