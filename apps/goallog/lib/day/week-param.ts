import { addWeeksToCivilDate, isCivilDate, weekOf } from "@/lib/zone";

export type WeekParam =
  | { kind: "this" }
  | { kind: "past"; monday: string }
  | { kind: "coming"; monday: string }
  | { kind: "redirect" };

// `?semana=` names another week by any of its days; a malformed value, an
// array leaves the screen for `/semana` itself; a week past `lastMonday` is
// "redirect" too, and the screen sends it to that last week (RP-142).
// Civil dates compare as strings, and the Monday comes from `weekOf`, never
// from `Date`. `lastMonday` defaults to this week's: no coming week.
export function parseWeekParam(
  raw: string | string[] | undefined,
  today: string,
  lastMonday: string = weekOf(today)[0],
): WeekParam {
  if (raw === undefined) return { kind: "this" };
  if (typeof raw !== "string" || !isCivilDate(raw)) return { kind: "redirect" };

  const monday = weekOf(raw)[0];
  const thisMonday = weekOf(today)[0];
  if (monday === thisMonday) return { kind: "this" };
  if (monday > thisMonday) return monday <= lastMonday ? { kind: "coming", monday } : { kind: "redirect" };
  return { kind: "past", monday };
}

// The Mondays either side of a week. `next` is null on `lastMonday`; the step
// to this week is `thisMonday`, which the screen links as `/semana`.
export function weekSteps({
  monday,
  thisMonday,
  firstMonday,
  lastMonday = thisMonday,
}: {
  monday: string;
  thisMonday: string;
  firstMonday: string | null;
  lastMonday?: string;
}): { prev: string | null; next: string | null } {
  return {
    prev: firstMonday === null || monday <= firstMonday ? null : addWeeksToCivilDate(monday, -1),
    next: monday >= lastMonday ? null : addWeeksToCivilDate(monday, 1),
  };
}
