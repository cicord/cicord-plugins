/**
 * When recurring announcements fire: 5-field cron, an interval, or a one-off date, all in
 * the announcement's time zone (local minutes, see tz.ts). The runtime's own schedules are
 * UTC-only and fixed in the code, so the plugin ticks every minute and evaluates these.
 */
import { formatLocal, parseLocal, toLocal, toUtc } from "./tz.ts";

export interface Cron {
  minutes: Set<number>;
  hours: Set<number>;
  doms: Set<number>;
  months: Set<number>;
  dows: Set<number>;
  /** Day of month / day of week restricted (standard cron: either matches when both are). */
  domRestricted: boolean;
  dowRestricted: boolean;
}

const NAMES: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

const DESCRIPTORS: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

function value(s: string, min: number, max: number): number {
  const n = /^\d+$/.test(s) ? Number(s) : NAMES[s.toLowerCase()];
  if (n === undefined || n < min || n > max)
    throw new Error(`"${s}" is out of range ${min}-${max}`);
  return n;
}

function field(text: string, min: number, max: number): { set: Set<number>; restricted: boolean } {
  const set = new Set<number>();
  for (const part of text.split(",")) {
    const [range = "", stepText] = part.split("/");
    const step = stepText === undefined ? 1 : value(stepText, 1, max - min + 1);
    let lo = min;
    let hi = max;
    if (range !== "*") {
      const [a = "", b] = range.split("-");
      lo = value(a, min, max);
      hi = b === undefined ? (stepText === undefined ? lo : max) : value(b, min, max);
      if (hi < lo) throw new Error(`"${range}" is an empty range`);
    }
    for (let v = lo; v <= hi; v += step) set.add(v);
  }
  return { set, restricted: text !== "*" && !text.startsWith("*/") };
}

/** Parses a 5-field cron expression (or @daily…). Throws a readable error. */
export function parseCron(expr: string): Cron {
  const text = DESCRIPTORS[expr.trim().toLowerCase()] ?? expr.trim();
  const parts = text.split(/\s+/);
  if (parts.length !== 5)
    throw new Error("a cron expression has 5 fields: minute hour day month weekday");
  const [mi, h, dom, mo, dow] = parts as [string, string, string, string, string];
  const d = field(dow, 0, 7);
  if (d.set.has(7)) {
    d.set.delete(7);
    d.set.add(0);
  }
  const days = field(dom, 1, 31);
  return {
    minutes: field(mi, 0, 59).set,
    hours: field(h, 0, 23).set,
    doms: days.set,
    months: field(mo, 1, 12).set,
    dows: d.set,
    domRestricted: days.restricted,
    dowRestricted: d.restricted,
  };
}

function dayMatches(c: Cron, date: Date): boolean {
  if (!c.months.has(date.getUTCMonth() + 1)) return false;
  const dom = c.doms.has(date.getUTCDate());
  const dow = c.dows.has(date.getUTCDay());
  if (c.domRestricted && c.dowRestricted) return dom || dow;
  return dom && dow;
}

function cronMatches(c: Cron, local: number): boolean {
  const d = new Date(local * 60_000);
  return c.minutes.has(d.getUTCMinutes()) && c.hours.has(d.getUTCHours()) && dayMatches(c, d);
}

/** First local minute strictly after `local` matching the cron (day by day, ≤ 5 years). */
function nextCron(c: Cron, local: number): number | undefined {
  const hours = [...c.hours].toSorted((a, b) => a - b);
  const minutes = [...c.minutes].toSorted((a, b) => a - b);
  const startDay = Math.floor(local / 1440);
  for (let day = startDay; day < startDay + 1830; day++) {
    if (!dayMatches(c, new Date(day * 86_400_000))) continue;
    for (const h of hours)
      for (const m of minutes) {
        const candidate = day * 1440 + h * 60 + m;
        if (candidate > local) return candidate;
      }
  }
  return undefined;
}

const UNITS: Record<string, number> = { m: 1, h: 60, d: 1440, w: 10080 };
/** Anchor of intervals without `start`: Monday 2024-01-01 00:00 (local). */
const DEFAULT_START = Date.UTC(2024, 0, 1) / 60_000;
const MIN_INTERVAL = 5;

/** "30m", "6h", "1d", "2w" → minutes. */
function parseEvery(text: string): number | undefined {
  const m = /^([1-9]\d{0,4})([mhdw])$/.exec(text.trim());
  return m ? Number(m[1]) * (UNITS[m[2] as string] as number) : undefined;
}

/** A configured recurring announcement's schedule, as the plugin evaluates it. */
export type Schedule =
  | { kind: "cron"; cron: Cron; text: string }
  | { kind: "every"; minutes: number; start: number; text: string }
  | { kind: "at"; at: number; text: string };

export interface ScheduleInput {
  cron?: string;
  every?: string;
  start?: string;
  at?: string;
}

/** Validates the schedule fields of an announcement (exactly one of cron, every, at). */
export function parseSchedule(a: ScheduleInput): Schedule {
  const given = [a.cron, a.every, a.at].filter((v) => v !== undefined).length;
  if (given !== 1) throw new Error("set exactly one of cron, every or at");
  if (a.cron !== undefined) {
    try {
      return { kind: "cron", cron: parseCron(a.cron), text: `cron \`${a.cron}\`` };
    } catch (error) {
      throw new Error(`invalid cron "${a.cron}": ${(error as Error).message}`, { cause: error });
    }
  }
  if (a.every !== undefined) {
    const minutes = parseEvery(a.every);
    if (minutes === undefined)
      throw new Error(`invalid interval "${a.every}" (e.g. 30m, 6h, 1d, 2w)`);
    if (minutes < MIN_INTERVAL) throw new Error(`intervals are at least ${MIN_INTERVAL} minutes`);
    let start = DEFAULT_START;
    if (a.start !== undefined) {
      const s = parseLocal(a.start);
      if (s === undefined) throw new Error(`invalid start "${a.start}" (YYYY-MM-DD HH:MM)`);
      start = s;
    }
    const from = a.start !== undefined ? ` from ${formatLocal(start)}` : "";
    return { kind: "every", minutes, start, text: `every ${a.every}${from}` };
  }
  const at = parseLocal(a.at ?? "");
  if (at === undefined) throw new Error(`invalid date "${a.at}" (YYYY-MM-DD HH:MM)`);
  return { kind: "at", at, text: `once, ${formatLocal(at)}` };
}

function matches(s: Schedule, local: number): boolean {
  if (s.kind === "cron") return cronMatches(s.cron, local);
  if (s.kind === "every") return local >= s.start && (local - s.start) % s.minutes === 0;
  return local === s.at;
}

/** Next firing after the UTC minute `afterUtc`, as a UTC minute (undefined: never again). */
export function nextRun(s: Schedule, zone: string, afterUtc: number): number | undefined {
  const local = toLocal(zone, afterUtc);
  let next: number | undefined;
  switch (s.kind) {
    case "cron":
      next = nextCron(s.cron, local);
      break;
    case "every":
      next =
        local < s.start
          ? s.start
          : s.start + (Math.floor((local - s.start) / s.minutes) + 1) * s.minutes;
      break;
    case "at":
      next = s.at > local ? s.at : undefined;
      break;
  }
  return next === undefined ? undefined : toUtc(zone, next);
}

/**
 * The latest local minute in the UTC minutes [fromUtc, toUtc] at which the schedule fires
 * and that is after `firedLocal` (dedupe across ticks, restarts and DST repeats).
 */
export function dueIn(
  s: Schedule,
  zone: string,
  fromUtc: number,
  toUtcMinute: number,
  firedLocal: number | undefined,
): number | undefined {
  let due: number | undefined;
  for (let u = fromUtc; u <= toUtcMinute; u++) {
    const local = toLocal(zone, u);
    if ((firedLocal === undefined || local > firedLocal) && matches(s, local)) due = local;
  }
  return due;
}
