import { parseLocal, toLocal, toUtc } from "./tz.ts";

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
