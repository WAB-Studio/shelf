import { PAST_DAY_LIMIT } from "@/lib/validation/fact";
import { civilDateToDate, dateToCivilDate } from "@/lib/zone";

// Where a day of the week leads (RP-06): its own screen when it is before
// today and no more than `PAST_DAY_LIMIT` back, nowhere otherwise — today is
// Hoy itself, which the tab bar already reaches. Civil dates compare as
// strings; the floor goes through `Date` to cross months.
export function weekDayHref(day: string, today: string): string | null {
  const floor = civilDateToDate(today);
  floor.setUTCDate(floor.getUTCDate() - PAST_DAY_LIMIT);
  if (day >= today || day < dateToCivilDate(floor)) return null;
  return `/dia/${day}`;
}
