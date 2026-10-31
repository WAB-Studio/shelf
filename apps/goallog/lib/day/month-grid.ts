import { addDaysToCivilDate, weekOf } from "@/lib/zone";

export type GridDay = {
  day: string;
  // Outside the month: the week's edge, drawn quiet.
  inMonth: boolean;
  // 0 nothing done, 1 to 4 the share of the month's busiest day.
  level: 0 | 1 | 2 | 3 | 4;
  count: number;
};

// The days a month touches as Monday-to-Sunday weeks, each day with its intensity: the day's count against the
// month's busiest day, in four steps. A day with anything done is never level 0.
export function monthGrid(month: string, counts: Readonly<Record<string, number>>): GridDay[][] {
  const first = `${month.slice(0, 7)}-01`;
  const next = `${addDaysToCivilDate(`${month.slice(0, 7)}-28`, 4).slice(0, 7)}-01`;
  const last = addDaysToCivilDate(next, -1);
  const peak = Math.max(0, ...Object.entries(counts).filter(([day]) => day >= first && day <= last).map(([, n]) => n));
  const weeks: GridDay[][] = [];
  for (let monday = weekOf(first)[0]; monday <= last; monday = addDaysToCivilDate(monday, 7)) {
    weeks.push(
      weekOf(monday).map((day) => {
        const inMonth = day >= first && day <= last;
        const count = inMonth ? (counts[day] ?? 0) : 0;
        const level = count === 0 || peak === 0 ? 0 : (Math.max(1, Math.ceil((count * 4) / peak)) as 1 | 2 | 3 | 4);
        return { day, inMonth, level, count };
      }),
    );
  }
  return weeks;
}
