import type { SourceKey } from "@/i18n/translator";
import { sourceKey } from "@/i18n/translator";

import { sharedRows } from "./shared-read";
import { readableApp } from "./timelog-names";
import type { EvidenceReader } from "./types";

// `timelog.app_seconds` (apps/timelog/db/schema/app-seconds.ts) is read in `shared-read.ts`: same database and
// `auth.users` id as GoalLog, TimeLog's own `app_seconds_select_self` policy narrows the rows, and its `day` is
// already a civil day in TimeLog's zone (RT-01).
const UNIT = "minutos";

/**
 * Every TimeLog source, as configuration: `apps` are names as TimeLog shows
 * them, `null` is the day's whole total at the computer. A new app, or a set
 * of them, is one line here, one in `messages/es/sources.json` and a row from
 * `npm run source:add`, never a migration (RNP-10).
 */
export const TIMELOG_SOURCES: readonly {
  key: string;
  labelKey: SourceKey;
  apps: readonly string[] | null;
}[] = [
  { key: "timelog_total", labelKey: sourceKey("sources.timelogTotal"), apps: null },
  { key: "timelog_app_vscode", labelKey: sourceKey("sources.timelogVsCode"), apps: ["VS Code"] },
  { key: "timelog_app_terminal", labelKey: sourceKey("sources.timelogTerminal"), apps: ["Terminal"] },
  { key: "timelog_app_browsers", labelKey: sourceKey("sources.timelogBrowsers"), apps: ["Chrome", "Edge", "Firefox", "Brave"] },
  { key: "timelog_app_word", labelKey: sourceKey("sources.timelogWord"), apps: ["Word"] },
  { key: "timelog_app_excel", labelKey: sourceKey("sources.timelogExcel"), apps: ["Excel"] },
  { key: "timelog_app_figma", labelKey: sourceKey("sources.timelogFigma"), apps: ["Figma"] },
];

type DayApp = { day: string; app: string; seconds: number };

/**
 * Seconds to whole minutes, per civil day; a day under thirty seconds is no
 * day of evidence. Pure, so the mapping is tested without a database.
 */
export function minutesPerDay(
  rows: readonly DayApp[],
  apps: readonly string[] | null,
): { day: string; minutes: number }[] {
  const seconds = new Map<string, number>();
  for (const row of rows) {
    if (apps !== null) {
      const name = readableApp(row.app);
      if (name === null || !apps.includes(name)) continue;
    }
    seconds.set(row.day, (seconds.get(row.day) ?? 0) + row.seconds);
  }
  return [...seconds]
    .map(([day, total]) => ({ day, minutes: Math.round(total / 60) }))
    .filter((one) => one.minutes >= 1)
    .sort((a, b) => a.day.localeCompare(b.day));
}

export function timelogReader(source: (typeof TIMELOG_SOURCES)[number]): EvidenceReader {
  return async ({ from, to, zone, tx }) => {
    const { timelog } = await sharedRows(tx, from, to, zone);
    return minutesPerDay(timelog, source.apps).map((one) => ({
      day: one.day,
      quantity: one.minutes,
      unit: UNIT,
      labelKey: source.labelKey,
    }));
  };
}

export const TIMELOG_UNIT = UNIT;
