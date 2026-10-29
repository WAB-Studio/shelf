import type { MessageKey } from "@/i18n/translator";

import type { Correction } from "./draft";

type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;

// A correction stores the plan's words as codes and numbers; the review phrases them here from the
// catalogue. An older draft in the browser's storage still carries them as Spanish: `said` stands in.

export function rateWords(translate: Translate, c: Pick<Correction, "said" | "values">): { rate: string; said: string } {
  const unit = c.values?.rateUnit;
  if (unit === undefined) return { rate: c.said, said: c.said };
  const rate = translate("import.review.words.rate", { amount: c.said, unit, measure: c.values?.measure ?? "" });
  return { rate, said: translate("import.review.words.perWeek", { rate }) };
}

export function cadenceWords(translate: Translate, c: Pick<Correction, "values">): string {
  const n = c.values?.n;
  return translate("import.review.words.cadence", { kind: c.values?.kind ?? "daily", n: n === undefined || n === "" ? 1 : Number(n) });
}

// `days` is the correction's `proposed`: ISO weekdays, Monday first, comma-separated.
export function daysWords(translate: Translate, days: string, names: string[]): string {
  if (!/^[1-7](,[1-7])*$/.test(days)) return days;
  return days
    .split(",")
    .map((day) => names[Number(day) - 1])
    .join(translate("import.review.words.daysJoin"));
}
