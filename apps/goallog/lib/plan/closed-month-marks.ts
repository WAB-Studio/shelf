import { dayBefore } from "@/lib/day/weeks";
import { PAST_DAY_LIMIT } from "@/lib/validation/fact";
import { civilDateToDate, dateToCivilDate } from "@/lib/zone";

import { nextMonth } from "./months";

// The day a closed month's task is marked done on (RP-143): its last day, while that day is within
// a fact's reach (RP-129), so a task done on the 31st and logged on the 2nd counts in its own month.
// Null once the reach has passed, and for a month not yet closed: the month is read only.
export function closedMonthMarkDay(month: string, today: string): string | null {
  const last = dayBefore(nextMonth(`${month.slice(0, 7)}-01`));
  const floor = civilDateToDate(today);
  floor.setUTCDate(floor.getUTCDate() - PAST_DAY_LIMIT);
  return last < today && last >= dateToCivilDate(floor) ? last : null;
}
