import { civilDateToDate, dateToCivilDate, todayInZone } from "@/lib/zone";

// Noon in Bogotá of a civil day: the same day in the zone and in UTC.
export function noonOf(day: string): Date {
  return new Date(`${day}T17:00:00Z`);
}

// A civil day offset from the app's «today» (the server's pinned clock when it has one).
export function dayFromToday(days: number): string {
  const date = civilDateToDate(todayInZone());
  date.setUTCDate(date.getUTCDate() + days);
  return dateToCivilDate(date);
}

// A timestamp at noon in Bogotá, `days` from the app's «today».
export function noonFromToday(days: number): Date {
  return noonOf(dayFromToday(days));
}
