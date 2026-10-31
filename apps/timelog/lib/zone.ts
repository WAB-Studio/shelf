export const TIME_ZONE = "America/Bogota";

const civil = new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" });

// `YYYY-MM-DD` of `at` on Bogotá's clock.
export function civilDay(at: Date = new Date()): string {
  return civil.format(at);
}

// A real calendar day: `2026-02-30` parses in JavaScript but is no day.
export function isCivilDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function addDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

const WALL_CLOCK = new Intl.DateTimeFormat("en-GB", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });

// The instant a civil day begins on Bogotá's clock.
export function dayStart(day: string): Date {
  const guess = Date.parse(`${day}T00:00:00Z`);
  const parts = WALL_CLOCK.formatToParts(new Date(guess));
  const part = (type: string) => Number(parts.find((one) => one.type === type)?.value ?? 0);
  const wall = Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"), part("second"));
  return new Date(guess - (wall - guess));
}
