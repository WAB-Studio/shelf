// The reader's zone is the device's: the record lives on the device, and the server (UTC in production)
// never knows where its reader is.
export function deviceZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function yearIn(at: number, zone: string): string {
  return new Intl.DateTimeFormat("en", { year: "numeric", timeZone: zone }).format(at);
}

// A date reads without its year while it falls in the year `now` is in; any other year is named.
export function yearWhenDifferent(
  at: number,
  now: number,
  zone: string = deviceZone(),
): { year: "numeric" } | Record<string, never> {
  return yearIn(at, zone) === yearIn(now, zone) ? {} : { year: "numeric" };
}

// The civil day `at` falls on in `zone`, as YYYY-MM-DD.
export function civilDay(at: number, zone: string = deviceZone()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: zone,
  }).formatToParts(at);
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${pick("year")}-${pick("month")}-${pick("day")}`;
}

// The calendar day before a YYYY-MM-DD, whatever the zone's clock did that night.
export function dayBefore(day: string): string {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, date - 1)).toISOString().slice(0, 10);
}
