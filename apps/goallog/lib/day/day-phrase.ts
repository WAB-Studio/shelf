import type { MessageKey } from "@/i18n/translator";
import { civilDateToDate, dateToCivilDate } from "@/lib/zone";
import { dayWords } from "@/lib/day/day-words";

export type DayNames = { weekdays: string[]; months: string[] };

type Translate = (key: MessageKey, values: Record<string, string | number>) => string;

// A phrase that has a `…Far` twin in the catalogue.
export type DayPhraseKey = MessageKey extends infer K ? (K extends `${infer Base}Far` ? Base : never) : never;

// The parts a phrase names a day with: `far` says the month is in them, so the
// caller reads the `…Far` catalogue key.
function farDayParts(day: string, today: string, names: DayNames) {
  const words = dayWords(day, today);
  return {
    far: words.month !== null,
    parts: {
      weekday: names.weekdays[words.weekday],
      day: words.day,
      month: words.month === null ? "" : names.months[words.month],
    },
  };
}

// `key` names the phrase without its month; a day outside the week of `today`
// reads `${key}Far` instead.
export function dayPhrase(
  translate: Translate,
  key: DayPhraseKey,
  day: string,
  today: string,
  names: DayNames,
  extra: Record<string, string> = {},
): string {
  const { far, parts } = farDayParts(day, today, names);
  return translate(far ? `${key}Far` : key, { ...parts, ...extra });
}

// Hoy's «terminó» line for a goal whose last day was `lastDay`: «ayer» the day
// after, the named day with its month and year later.
export function endedPhrase(
  translate: Translate,
  goal: string,
  lastDay: string,
  today: string,
  names: DayNames,
): string {
  const date = civilDateToDate(today);
  date.setUTCDate(date.getUTCDate() - 1);
  if (lastDay === dateToCivilDate(date)) return translate("day.ended.yesterday", { goal });
  return endedOnPhrase(translate, goal, lastDay, names);
}

// «Azúcar terminó el lunes 28 de septiembre de 2026»: the month and the year
// always, a week away or not.
export function endedOnPhrase(translate: Translate, goal: string, lastDay: string, names: DayNames): string {
  const words = dayWords(lastDay, "1970-01-01");
  return translate("day.ended.on", {
    goal,
    weekday: names.weekdays[words.weekday],
    day: words.day,
    month: names.months[words.month ?? 0],
    year: lastDay.slice(0, 4),
  });
}
