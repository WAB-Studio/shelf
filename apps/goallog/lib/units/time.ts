// The words for a minute. A unit named any other way is not time and prints
// as it always has.
// An array too: the rhythm action hands the same list to the SQL.
export const TIME_UNITS = ["minutos", "minuto", "min", "mins"] as const;
const TIME_UNIT_SET: ReadonlySet<string> = new Set(TIME_UNITS);

// `useGrouping: "always"`: "es" leaves four digits bare by default, and a
// total of 1.234 h has to read as grouped as the figures beside it.
const grouped = new Intl.NumberFormat("es", { useGrouping: "always" });

// A count with no unit: «34», «1 000».
export const formatCount = (n: number): string => grouped.format(n);

// The words come from the caller's translator; this file never names one.
export type TimeWords = {
  h: (h: string) => string;
  min: (min: string) => string;
  join: (h: string, min: string) => string;
  // A unit word agreeing with the number; absent where a caller prints raw.
  unit?: (unit: string, n: number) => string;
};

// Words for an hour. Never in TIME_UNITS: what is stored in them keeps reading as it does.
export const HOUR_UNITS = ["horas", "hora", "h", "hours", "hour", "hrs", "hr"] as const;
const HOUR_UNIT_SET: ReadonlySet<string> = new Set(HOUR_UNITS);

export function isHourUnit(unit: string): boolean {
  return HOUR_UNIT_SET.has(unit.trim().toLowerCase());
}

// A minute said in English is not in TIME_UNITS (what is stored that way keeps reading as it does),
// but a new write keeps it as minutes.
const ENGLISH_MINUTE_SET: ReadonlySet<string> = new Set(["minutes", "minute"]);

export function isEnglishMinuteUnit(unit: string): boolean {
  return ENGLISH_MINUTE_SET.has(unit.trim().toLowerCase());
}

// What a commitment keeps: hours become whole minutes, English minutes become «minutos», any other unit stays.
export function storedMeasure(unit: string, amount: number | null): { unit: string; amount: number | null } {
  if (isEnglishMinuteUnit(unit)) return { unit: "minutos", amount };
  if (!isHourUnit(unit)) return { unit, amount };
  return { unit: "minutos", amount: amount === null ? null : amount * 60 };
}

export function isTimeUnit(unit: string | null): boolean {
  return unit !== null && TIME_UNIT_SET.has(unit.trim().toLowerCase());
}

export function splitMinutes(n: number): { h: number; min: number } {
  return { h: Math.floor(n / 60), min: n % 60 };
}

export function formatTime(n: number, words: TimeWords): string {
  const { h, min } = splitMinutes(n);
  if (h === 0) return words.min(grouped.format(min));
  if (min === 0) return words.h(grouped.format(h));
  return words.join(words.h(grouped.format(h)), words.min(String(min).padStart(2, "0")));
}

export function formatQuantity(n: number, unit: string, words: TimeWords): string {
  return isTimeUnit(unit) ? formatTime(n, words) : `${grouped.format(n)} ${words.unit?.(unit, n) ?? unit}`;
}

const NUMBER = String.raw`(\d+(?:[.,]\d+)?)`;
const PATTERN = new RegExp(
  String.raw`^(?:${NUMBER}\s*h(?:oras?|rs?|s)?(?:\s*(\d+)\s*(?:min|mins|minutos?))?|(\d+)\s*(?:min|mins|minutos?))$`,
  "i",
);

// Minutes from «12 h», «1,5 h», «12 h 30 min», «90 min». A fraction of an
// hour is read in integers (hundredths of an hour) so no float is ever held.
export function parseTime(text: string): number | null {
  const match = PATTERN.exec(text.trim());
  if (!match) return null;
  const [, hours, minutes, onlyMinutes] = match;
  if (onlyMinutes !== undefined) return Number(onlyMinutes);
  const [whole, fraction = ""] = hours.replace(",", ".").split(".");
  if (fraction !== "" && minutes !== undefined) return null;
  // fraction / 10^k hours -> minutes = whole*60 + fraction*60 / 10^k, exact or null.
  const scaled = Number(fraction || "0") * 60;
  const unit = 10 ** fraction.length;
  if (scaled % unit !== 0) return null;
  return Number(whole) * 60 + scaled / unit + Number(minutes ?? 0);
}

export type FieldMinutes =
  | { kind: "blank" }
  | { kind: "minutes"; minutes: number }
  | { kind: "hoursInvalid" }
  | { kind: "minutesInvalid" };

const WHOLE = /^\d+$/;

// The «h» and «min» field pair read into minutes. One blank field reads as 0;
// integers only, and minutes stop at 59.
export function minutesFromFields(hours: string, minutes: string): FieldMinutes {
  const h = hours.trim();
  const m = minutes.trim();
  if (h === "" && m === "") return { kind: "blank" };
  if (h !== "" && !WHOLE.test(h)) return { kind: "hoursInvalid" };
  if (m !== "" && (!WHOLE.test(m) || Number(m) > 59)) return { kind: "minutesInvalid" };
  return { kind: "minutes", minutes: Number(h || "0") * 60 + Number(m || "0") };
}
