import { addWeeksToCivilDate, isCivilDate, weekOf } from "@/lib/zone";

export type WeekParam = { kind: "this" } | { kind: "past"; monday: string } | { kind: "redirect" };

// `?semana=` names a past week by any of its days; a malformed value, an
// array or a future week leaves the screen for `/semana` itself. Civil dates
// compare as strings, and the Monday comes from `weekOf`, never from `Date`.
export function parseWeekParam(raw: string | string[] | undefined, today: string): WeekParam {
  if (raw === undefined) return { kind: "this" };
  if (typeof raw !== "string" || !isCivilDate(raw)) return { kind: "redirect" };

  const monday = weekOf(raw)[0];
  const thisMonday = weekOf(today)[0];
  if (monday === thisMonday) return { kind: "this" };
  if (monday > thisMonday) return { kind: "redirect" };
  return { kind: "past", monday };
}

// The Mondays either side of a week. `next` is null on this week; the step
// to this week is `thisMonday`, which the screen links as `/semana`.
export function weekSteps({
  monday,
  thisMonday,
  firstMonday,
}: {
  monday: string;
  thisMonday: string;
  firstMonday: string | null;
}): { prev: string | null; next: string | null } {
  return {
    prev: firstMonday === null || monday <= firstMonday ? null : addWeeksToCivilDate(monday, -1),
    next: monday >= thisMonday ? null : addWeeksToCivilDate(monday, 1),
  };
}
