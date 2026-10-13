import { civilDateToDate, dateToCivilDate } from "@/lib/zone";

function plusDays(day: string, days: number): string {
  const date = civilDateToDate(day);
  date.setUTCDate(date.getUTCDate() + days);
  return dateToCivilDate(date);
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

// A week counts once its Sunday is before `today` and the habit lived its Thursday.
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
  for (const monday of weeksOfMonth(month)) {
    const thursday = plusDays(monday, 3);
    if (plusDays(monday, 6) >= today) continue;
    if (createdOn > thursday) continue;
    if (retiredOn !== null && retiredOn < thursday) continue;
    counted += 1;
    if ((daysDoneByWeek.get(monday) ?? 0) >= count) met += 1;
  }
  return { met, counted };
}
