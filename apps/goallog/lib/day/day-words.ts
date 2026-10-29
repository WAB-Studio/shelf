import { civilDateToDate, weekOf } from "@/lib/zone";

// The parts a screen says a day with. `month` is null inside the week of
// `today`, so the screen picks the catalogue key that omits it.
export function dayWords(
  day: string,
  today: string,
): { weekday: number; day: number; month: number | null } {
  const date = civilDateToDate(day);
  return {
    // 0 is Monday, the order `day.weekdayLong` lists.
    weekday: (date.getUTCDay() + 6) % 7,
    day: date.getUTCDate(),
    month: weekOf(today).includes(day) ? null : date.getUTCMonth(),
  };
}
