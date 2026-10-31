import { localDay } from "@/lib/review/schedule";

export type DiaryDay<Row> = {
  // «today» and «yesterday» by the reader's own calendar; any other day carries its moment for formatting.
  when: "today" | "yesterday" | "other";
  at: number;
  rows: Row[];
};

// Rows gathered under the local day they were last searched, the newest day first; inside a day the most
// searched leads, then the most recent.
export function groupByDay<Row extends { lastAt: number; count: number }>(rows: readonly Row[], now: number): DiaryDay<Row>[] {
  const today = localDay(now);
  const yesterday = localDay(new Date(new Date(now).setDate(new Date(now).getDate() - 1)).getTime());
  const days: DiaryDay<Row>[] = [];
  const byDay = new Map<string, DiaryDay<Row>>();
  for (const row of [...rows].sort((a, b) => localDay(b.lastAt).localeCompare(localDay(a.lastAt)) || b.count - a.count || b.lastAt - a.lastAt)) {
    const key = localDay(row.lastAt);
    let day = byDay.get(key);
    if (day === undefined) {
      day = { when: key === today ? "today" : key === yesterday ? "yesterday" : "other", at: row.lastAt, rows: [] };
      byDay.set(key, day);
      days.push(day);
    }
    day.rows.push(row);
  }
  return days;
}
