import { ZONES } from "./tz.ts";
import { localMs } from "./zoned.ts";

export type CalendarItem = {
  id: string;
  name: string;
  start: string;
  end?: string;
  description?: string;
  location?: string;
  weekly?: boolean;
  /** Zone whose local time a weekly item keeps (DTSTART;TZID with a VTIMEZONE). */
  timeZone?: string;
};
const escapeText = (s: string) =>
  s
    .replace(/\\/g, "\\\\")
    .replace(/\r\n|\n|\r/g, "\\n")
    .replace(/[,;]/g, (c) => "\\" + c);
const stamp = (s: string) =>
  new Date(s)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
/** Local wall-clock time as an iCalendar DATE-TIME without a zone suffix. */
const localStamp = (zone: string, s: string) =>
  stamp(new Date(localMs(zone, Date.parse(s))).toISOString()).slice(0, -1);
const pad = (n: number) => String(n).padStart(2, "0");
const offset = (minutes: number) =>
  (minutes < 0 ? "-" : "+") + pad(Math.floor(Math.abs(minutes) / 60)) + pad(Math.abs(minutes) % 60);
/** Day of the month of the n-th Sunday (n = -1: the last) of a 1970 month (1-based). */
function sunday(month: number, n: number) {
  if (n > 0)
    return 1 + ((7 - new Date(Date.UTC(1970, month - 1, 1)).getUTCDay()) % 7) + (n - 1) * 7;
  const last = new Date(Date.UTC(1970, month, 0));
  return last.getUTCDate() - last.getUTCDay();
}
// Rules of tz.ts: [month, n-th Sunday, local minutes] of the DST start (standard time) and
// of its end (daylight time). The EU switches at 01:00 UTC everywhere.
const RULES = {
  eu: (std: number) => [
    [3, -1, 60 + std],
    [10, -1, 120 + std],
  ],
  us: () => [
    [3, 2, 120],
    [11, 1, 120],
  ],
  au: () => [
    [10, 1, 120],
    [4, 1, 180],
  ],
  nz: () => [
    [9, -1, 120],
    [4, 1, 180],
  ],
} as const;
function vtimezone(zone: string): string[] {
  const [std, rule] = ZONES[zone] ?? [0, "none"];
  const part = (kind: string, from: number, to: number, at?: readonly number[]) => {
    const [month, n, minutes] = at ?? [1, 0, 0];
    const day = at ? sunday(month!, n!) : 1;
    const byday = n! < 0 ? "-1SU" : n + "SU";
    return [
      "BEGIN:" + kind,
      `DTSTART:1970${pad(month!)}${pad(day)}T${pad(Math.floor(minutes! / 60))}${pad(minutes! % 60)}00`,
      ...(at ? [`RRULE:FREQ=YEARLY;BYMONTH=${month};BYDAY=${byday}`] : []),
      "TZOFFSETFROM:" + offset(from),
      "TZOFFSETTO:" + offset(to),
      "END:" + kind,
    ];
  };
  const body =
    rule === "none"
      ? part("STANDARD", std, std)
      : [
          ...part("DAYLIGHT", std, std + 60, RULES[rule](std)[0]),
          ...part("STANDARD", std + 60, std, RULES[rule](std)[1]),
        ];
  return ["BEGIN:VTIMEZONE", "TZID:" + zone, ...body, "END:VTIMEZONE"];
}
function fold(s: string) {
  let out = "",
    bytes = 0;
  for (const c of s) {
    const n = c.codePointAt(0)!;
    const size = n < 128 ? 1 : n < 2048 ? 2 : n < 65536 ? 3 : 4;
    if (bytes + size > 75) {
      out += "\r\n ";
      bytes = 1;
    }
    out += c;
    bytes += size;
  }
  return out;
}
export function ics(items: CalendarItem[], scope: string, updated: string) {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Cicord//Community Events//EN",
    "CALSCALE:GREGORIAN",
  ];
  const zones = [...new Set(items.flatMap((e) => (e.timeZone ? [e.timeZone] : [])))];
  for (const zone of zones) lines.push(...vtimezone(zone));
  // A zoned weekly item repeats at its local time; others keep their UTC time.
  const at = (e: CalendarItem, s: string) =>
    e.timeZone ? `;TZID=${e.timeZone}:${localStamp(e.timeZone, s)}` : ":" + stamp(s);
  for (const e of items) {
    lines.push(
      "BEGIN:VEVENT",
      "UID:" + escapeText(e.id + "." + scope + "@cicord"),
      "DTSTAMP:" + stamp(updated),
      "DTSTART" + at(e, e.start),
      "SUMMARY:" + escapeText(e.name),
    );
    if (e.end) lines.push("DTEND" + at(e, e.end));
    if (e.description) lines.push("DESCRIPTION:" + escapeText(e.description));
    if (e.location) lines.push("LOCATION:" + escapeText(e.location));
    if (e.weekly) lines.push("RRULE:FREQ=WEEKLY");
    lines.push("END:VEVENT");
  }
  return [...lines, "END:VCALENDAR"].map(fold).join("\r\n") + "\r\n";
}
