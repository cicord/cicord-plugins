export type CalendarItem = {
  id: string;
  name: string;
  start: string;
  end?: string;
  description?: string;
  location?: string;
  weekly?: boolean;
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
  for (const e of items) {
    lines.push(
      "BEGIN:VEVENT",
      "UID:" + escapeText(e.id + "." + scope + "@cicord"),
      "DTSTAMP:" + stamp(updated),
      "DTSTART:" + stamp(e.start),
      "SUMMARY:" + escapeText(e.name),
    );
    if (e.end) lines.push("DTEND:" + stamp(e.end));
    if (e.description) lines.push("DESCRIPTION:" + escapeText(e.description));
    if (e.location) lines.push("LOCATION:" + escapeText(e.location));
    if (e.weekly) lines.push("RRULE:FREQ=WEEKLY");
    lines.push("END:VEVENT");
  }
  return [...lines, "END:VCALENDAR"].map(fold).join("\r\n") + "\r\n";
}
