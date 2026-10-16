// The only file under `apps/goallog` allowed to name a time zone. Every other
// module reaches the person's day through the functions below, never through
// `Date`'s local-offset behaviour or the process's own `TZ`.
export const TIME_ZONE = "America/Bogota";

// One formatter per locale and options: building one per call piled up GBs
// of native memory in loops over thousands of days.
const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale}|${JSON.stringify(options)}`;
  let cached = formatters.get(key);
  if (!cached) {
    cached = new Intl.DateTimeFormat(locale, options);
    formatters.set(key, cached);
  }
  return cached;
}

// Any instant, read back as its calendar day in the person's zone. `Intl`
// takes the zone as an argument, so this never depends on the process's own
// `TZ` — a suite run under `TZ=UTC` reads the same day as one run without it.
export function civilDateInZone(instant: Date): string {
  return formatter("en-CA", { timeZone: TIME_ZONE }).format(instant);
}

// The day every reader calls «today». `PULSAR_CLOCK` pins it on a test
// server; the browser reads the pin from the `pulsar-clock` meta the signed-in
// layout draws, so a client component agrees with the page that drew it.
export function todayInZone(): string {
  const pinned =
    typeof window === "undefined"
      ? clockOverride(process.env)
      : (document.querySelector(`meta[name="${CLOCK_META}"]`)?.getAttribute("content") ?? null);
  return pinned ?? civilDateInZone(new Date());
}

export const CLOCK_META = "pulsar-clock";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

// `PULSAR_CLOCK=YYYY-MM-DD`, honoured only beside a loopback `DATABASE_URL`:
// `scripts/supabase-local.sh exec` and CI's local stack set one, production
// never can. Not `HARNESS_LANE` (lane 1 leaves it unset) and not `NODE_ENV`
// (`next start` is `production` too). Anywhere else it throws, never ignores.
export function clockOverride(env: Record<string, string | undefined>): string | null {
  const pinned = env.PULSAR_CLOCK?.trim();
  if (!pinned) return null;
  if (!isCivilDate(pinned)) throw new Error(`PULSAR_CLOCK must be a real YYYY-MM-DD, not "${pinned}"`);

  let host: string | null = null;
  try {
    host = env.DATABASE_URL ? new URL(env.DATABASE_URL).hostname : null;
  } catch {
    host = null;
  }
  if (env.VERCEL || !host || !LOOPBACK.has(host)) {
    throw new Error("PULSAR_CLOCK is test-only: set it only beside the local stack's DATABASE_URL, never on Vercel");
  }
  return pinned;
}

// Rejects a shape match that names no real day, such as "2026-02-31".
export function isCivilDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;

  const [, yearStr, monthStr, dayStr] = match;
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  const date = new Date(Date.UTC(year, month - 1, day));

  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

// Midday UTC is the only instant a formatter is ever handed: every zone west
// of UTC+12 and east of UTC-12 still renders this as the same calendar day,
// so the naive `new Date("2026-08-27")` off-by-one-day bug cannot happen.
export function civilDateToDate(value: string): Date {
  return new Date(`${value}T12:00:00Z`);
}

// Reads a midday-UTC instant back as its own calendar day, never a shifted one.
export function dateToCivilDate(date: Date): string {
  return formatter("en-CA", { timeZone: "UTC" }).format(date);
}

// The civil date `weeks` weeks after `day`, in the same midday-UTC arithmetic
// `weekOf` already runs: a horizon typed in weeks (RP-11) is turned into the
// civil date `createGoal` stores, never the caller's own local offset.
export function addWeeksToCivilDate(day: string, weeks: number): string {
  const date = civilDateToDate(day);
  date.setUTCDate(date.getUTCDate() + weeks * 7);
  return dateToCivilDate(date);
}

// The seven civil days of the Monday-to-Sunday week `day` sits in, oldest
// first. The day-of-week is read from the midday-UTC instant, so no local
// offset shifts it.
export function weekOf(day: string): string[] {
  const monday = civilDateToDate(day);
  // `getUTCDay` is 0 for Sunday; `+ 6 mod 7` counts the days back to Monday.
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));

  const days: string[] = [];
  for (let i = 0; i < 7; i++) {
    days.push(dateToCivilDate(monday));
    monday.setUTCDate(monday.getUTCDate() + 1);
  }
  return days;
}

// "13 de diciembre", or "domingo 13 de diciembre" with `weekday`: a civil day
// in words, read from its own midday-UTC instant so no offset shifts it.
export function civilDateLabel(day: string, weekday = false): string {
  return formatter("es-CO", {
    weekday: weekday ? "long" : undefined,
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  }).format(civilDateToDate(day));
}

// "13 de diciembre de 2026": the year always comes from the day itself.
export function civilDateWithYear(day: string): string {
  return formatter("es-CO", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(civilDateToDate(day));
}

// "martes 22 sep": weekday, day and the month's first three letters, no
// punctuation. The month is cut from its long name because ICU's own short
// form is "sept" for September.
export function civilDateShort(day: string): string {
  const parts = formatter("es-CO", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  }).formatToParts(civilDateToDate(day));
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("weekday")} ${part("day")} ${part("month").slice(0, 3)}`;
}

// "13 sep": `civilDateShort` without the weekday.
export function civilDayMonthShort(day: string): string {
  const parts = formatter("es-CO", {
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  }).formatToParts(civilDateToDate(day));
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("day")} ${part("month").slice(0, 3)}`;
}

// "4 jul 2027": `civilDayMonthShort` with the year of the day itself.
export function civilDayMonthYear(day: string): string {
  return `${civilDayMonthShort(day)} ${day.slice(0, 4)}`;
}

// An instant as the 24-hour "HH:mm" a person in the zone read on their clock.
// `h23` keeps midnight "00:05", never "24:05".
export function timeInZone(instant: string): string {
  return formatter("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: TIME_ZONE,
  }).format(new Date(instant));
}
