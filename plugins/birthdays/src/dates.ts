import { toLocal, toUtc } from "./tz.ts";
export function validDate(month: number, day: number) {
  return (
    Number.isInteger(month) &&
    Number.isInteger(day) &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= new Date(Date.UTC(2000, month, 0)).getUTCDate()
  );
}
export function anniversary(year: number, month: number, day: number, hour: number, zone: string) {
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return toUtc(zone, Date.UTC(year, month - 1, Math.min(day, last), hour) / 60000) * 60000;
}
export const yearAt = (now: number, zone: string) =>
  new Date(toLocal(zone, Math.floor(now / 60000)) * 60000).getUTCFullYear();
