import { isCivilDate } from "@/lib/dates";

// The order a locale writes a civil date in: Spanish day first, English month first.
export type DateOrder = "dmy" | "mdy";

export function dateOrderOf(locale: string): DateOrder {
  return locale.startsWith("en") ? "mdy" : "dmy";
}

export function datePlaceholder(locale: string): string {
  if (locale.startsWith("en")) return "mm/dd/yyyy";
  return "dd/mm/aaaa";
}

// «2026-10-31» as the person reads it; anything that is not a civil date reads empty.
export function isoToText(iso: string, order: DateOrder): string {
  if (!isCivilDate(iso)) return "";
  const [year, month, day] = iso.split("-");
  return order === "dmy" ? `${day}/${month}/${year}` : `${month}/${day}/${year}`;
}

// What a person typed, back to the civil date the form holds: «31/10/2026» (or the
// order's own), «31-10-2026», or the ISO form itself. Null when it names no real day.
export function textToIso(text: string, order: DateOrder): string | null {
  const value = text.trim();
  if (isCivilDate(value)) return value;

  const match = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(value);
  if (!match) return null;

  const [, first, second, year] = match;
  const day = order === "dmy" ? first : second;
  const month = order === "dmy" ? second : first;
  const iso = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  return isCivilDate(iso) ? iso : null;
}
