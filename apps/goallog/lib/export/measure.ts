import { HOUR_UNITS, isTimeUnit } from "@/lib/units/time";

const HOUR_WORDS: ReadonlySet<string> = new Set(HOUR_UNITS);

// The name to print before «, en {unit}», or null when it only repeats the unit:
// the unit itself, one of its words, or any word for time. A trailing dot is not part of the word.
export function distinctMeasureName(
  name: string | null,
  unit: string,
  unitWords: readonly string[],
): string | null {
  if (name === null) return null;
  const clean = name.trim().toLowerCase().replace(/\.$/, "");
  if (clean === "") return null;
  const same = [unit, ...unitWords].some((word) => word.trim().toLowerCase() === clean);
  return same || isTimeUnit(clean) || HOUR_WORDS.has(clean) ? null : name;
}
