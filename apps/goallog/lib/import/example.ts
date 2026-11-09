import { lastDayOf, monthAfter } from "@/lib/plan/months";
import { todayInZone } from "@/lib/zone";

// The template's text example is written for 2026-10-01 (the catalogue and PLANTILLA.md keep it so). Shown or
// copied, it starts on `today`'s month, as the workbook does (RP-149): its months on that month and the next, its
// phase over three months from it, its goals ending 5, 12 and 24 months after it. One pass, so a month just
// written is never moved again.
export function movedExample(example: string, today: string = todayInZone()): string {
  const first = today.slice(0, 7);
  const moved: Record<string, string> = {
    "2026-10-01 a 2026-12-31": `${first}-01 a ${lastDayOf(monthAfter(first, 2))}`,
    "2028-10-01": `${monthAfter(first, 24)}-01`,
    "2027-10-01": `${monthAfter(first, 12)}-01`,
    "2027-03-01": `${monthAfter(first, 5)}-01`,
    "2026-10": first,
    "2026-11": monthAfter(first, 1),
  };
  return example.replace(/2026-10-01 a 2026-12-31|2028-10-01|2027-10-01|2027-03-01|2026-1[01]/g, (date) => moved[date]);
}
