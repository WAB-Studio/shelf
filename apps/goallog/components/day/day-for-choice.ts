import { civilDateToDate, dateToCivilDate } from "@/lib/zone";

export type DayChoiceKind = "today" | "tomorrow" | "other" | "none";

// `date` is only read for `other`, and may still be empty while the person
// has not picked one.
export type DayChoiceValue = { kind: DayChoiceKind; date: string };

export const DEFAULT_DAY_CHOICE: DayChoiceValue = { kind: "today", date: "" };

// Goes through `Date` rather than arithmetic on the string: a civil date
// crosses months and years.
function nextDay(day: string): string {
  const date = civilDateToDate(day);
  date.setUTCDate(date.getUTCDate() + 1);
  return dateToCivilDate(date);
}

// The civil day a choice names, or null for «sin día». An `other` with
// nothing picked yet returns "", which `createOneOffSchema` refuses.
export function dayForChoice(choice: DayChoiceValue, today: string): string | null {
  switch (choice.kind) {
    case "today":
      return today;
    case "tomorrow":
      return nextDay(today);
    case "other":
      return choice.date;
    case "none":
      return null;
  }
}
