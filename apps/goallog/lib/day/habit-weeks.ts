import { nextMonth } from "@/lib/plan/months";
import { civilDateToDate, dateToCivilDate, weekOf } from "@/lib/zone";

function plusDays(day: string, days: number): string {
  const date = civilDateToDate(day);
  date.setUTCDate(date.getUTCDate() + days);
  return dateToCivilDate(date);
}

function mondayOf(day: string): string {
  return weekOf(day)[0];
}

// A week belongs to the month of its Thursday.
export function weekMonthOf(monday: string): string {
  return `${plusDays(monday, 3).slice(0, 7)}-01`;
}

// The Mondays whose Thursday falls in `month`.
export function weeksOfMonth(month: string): string[] {
  const first = civilDateToDate(month);
  // Back to the Monday of the week holding the 1st, then forward while the Thursday is in the month.
  first.setUTCDate(first.getUTCDate() - ((first.getUTCDay() + 6) % 7));
  const weeks: string[] = [];
  for (let monday = dateToCivilDate(first); weekMonthOf(monday) <= month; monday = plusDays(monday, 7)) {
    if (weekMonthOf(monday) === month) weeks.push(monday);
  }
  return weeks;
}

// Every Monday of a week `month` touches, the one holding the 1st first: «Mes» links each (RP-145). Unlike
// `weeksOfMonth`, a week whose Thursday falls in the month next door is still here.
export function mondaysTouching(month: string): string[] {
  const last = plusDays(nextMonth(month), -1);
  const mondays: string[] = [];
  for (let monday = mondayOf(month); monday <= last; monday = plusDays(monday, 7)) mondays.push(monday);
  return mondays;
}

// A week counts once its Sunday is before `today` and the habit lived its Thursday.
// The week of retirement is judged at retirement: met, it counts in the month of `retiredOn`
// even when its Thursday is later; unmet, the Thursday rule above decides.
export function habitWeeks({
  count,
  createdOn,
  retiredOn,
  daysDoneByWeek,
  month,
  today,
}: {
  count: number;
  createdOn: string;
  retiredOn: string | null;
  daysDoneByWeek: Map<string, number>;
  month: string;
  today: string;
}): { met: number; counted: number } {
  let met = 0;
  let counted = 0;
  const retiredMonday = retiredOn === null ? null : mondayOf(retiredOn);
  const retiredMonth = retiredOn === null ? null : `${retiredOn.slice(0, 7)}-01`;
  const metBy = (monday: string) => (daysDoneByWeek.get(monday) ?? 0) >= count;
  const mondays = weeksOfMonth(month);
  if (retiredMonday !== null && retiredMonth === month && !mondays.includes(retiredMonday)) mondays.push(retiredMonday);
  for (const monday of mondays) {
    const thursday = plusDays(monday, 3);
    if (createdOn > thursday) continue;
    if (monday === retiredMonday && metBy(monday)) {
      if (retiredMonth !== month) continue;
      counted += 1;
      met += 1;
      continue;
    }
    // An unmet retirement week keeps the Thursday rule, so it never counts outside its Thursday's month.
    if (weekMonthOf(monday) !== month) continue;
    if (plusDays(monday, 6) >= today) continue;
    if (retiredOn !== null && retiredOn < thursday) continue;
    counted += 1;
    if (metBy(monday)) met += 1;
  }
  return { met, counted };
}

// The week in progress of a weekly habit: days done so far against the count; null once retired.
export function habitThisWeek({
  count,
  retiredOn,
  daysDoneByWeek,
  today,
}: {
  count: number;
  retiredOn: string | null;
  daysDoneByWeek: Map<string, number>;
  today: string;
}): { done: number; count: number } | null {
  if (retiredOn !== null) return null;
  return { done: daysDoneByWeek.get(mondayOf(today)) ?? 0, count };
}
