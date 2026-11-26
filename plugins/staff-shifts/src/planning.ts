import { ZONES, toLocal, toUtc } from "./tz.ts";
export type Shift = { day: number; start: number; minutes: number };
export type Plan = { zone: string; shifts: Shift[] };
export function validPlan(p: unknown): p is Plan {
  if (!p || typeof p !== "object") return false;
  const { zone, shifts } = p as Plan;
  return (
    Object.hasOwn(ZONES, zone) &&
    Array.isArray(shifts) &&
    shifts.length <= 28 &&
    shifts.every(
      (s) =>
        s &&
        Number.isInteger(s.day) &&
        s.day >= 0 &&
        s.day <= 6 &&
        Number.isInteger(s.start) &&
        s.start >= 0 &&
        s.start < 1440 &&
        Number.isInteger(s.minutes) &&
        s.minutes >= 15 &&
        s.minutes <= 1440,
    )
  );
}
// A shift starts on a local weekday. Its duration is elapsed time across a clock transition.
export function occurrences(p: Plan, from: number, to: number): { start: number; end: number }[] {
  const local = toLocal(p.zone, Math.floor(from / 60000)),
    first = Math.floor(local / 1440) - 1;
  const last = Math.floor(toLocal(p.zone, Math.ceil(to / 60000)) / 1440) + 1;
  const windows: { start: number; end: number }[] = [];
  for (let d = first; d <= last; d++) {
    const day = new Date(d * 86400000).getUTCDay();
    for (const s of p.shifts)
      if (s.day === day) {
        const start = toUtc(p.zone, d * 1440 + s.start) * 60000,
          end = start + s.minutes * 60000;
        if (start < to && end > from) windows.push({ start, end });
      }
  }
  return windows.sort((a, b) => a.start - b.start);
}
export function coverage(plans: Plan[], from: number, to: number) {
  const windows = plans.flatMap((p) => occurrences(p, from, to)).sort((a, b) => a.start - b.start);
  const gaps: { from: number; to: number }[] = [];
  let cursor = from;
  for (const w of windows) {
    if (w.start > cursor) gaps.push({ from: cursor, to: w.start });
    cursor = Math.max(cursor, w.end);
  }
  if (cursor < to) gaps.push({ from: cursor, to });
  return gaps;
}
