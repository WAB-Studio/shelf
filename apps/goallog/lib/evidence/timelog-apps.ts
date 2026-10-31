import { sql } from "drizzle-orm";
import { date, integer, pgSchema, text, uuid } from "drizzle-orm/pg-core";

import type { SourceKey } from "@/i18n/translator";
import type { Transaction } from "@/lib/session";
import { sourceKey } from "@/i18n/translator";

import { readableApp } from "./timelog-names";
import type { EvidenceReader } from "./types";

/**
 * A read-only reference to `apps/timelog`'s `timelog.app_seconds`
 * (apps/timelog/db/schema/app-seconds.ts), narrowed to the columns read here
 * and kept out of `db/schema/index.ts` for the reason `reading-lookups.ts`
 * gives. Same database and same `auth.users` id as GoalLog, so TimeLog's own
 * `app_seconds_select_self` policy narrows the rows to the caller's and no
 * mapping of people is needed. `day` is already a civil day in TimeLog's own
 * zone (RT-01), so no zone conversion happens here.
 */
const timelog = pgSchema("timelog");

const appSeconds = timelog.table("app_seconds", {
  userId: uuid().notNull(),
  day: date().notNull(),
  app: text().notNull(),
  seconds: integer().notNull(),
});

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

// Every source above asks the same question of the same transaction in the
// same fan, so the statement runs once per transaction and range and each
// reader filters its own apps from the answer (RNP-03).
const asked = new WeakMap<Transaction, { from: unknown; to: unknown; rows: Promise<DayApp[]> }>();

function rowsOf(tx: Transaction, from: Parameters<EvidenceReader>[0]["from"], to: Parameters<EvidenceReader>[0]["to"]) {
  const earlier = asked.get(tx);
  if (earlier && earlier.from === from && earlier.to === to) return earlier.rows;
  // Awaited once inside an async body: the builder is lazy and would run again for every reader that awaits it.
  const rows: Promise<DayApp[]> = (async () => await tx
    .select({
      day: sql<string>`${appSeconds.day}::text`,
      app: appSeconds.app,
      seconds: sql<number>`sum(${appSeconds.seconds})::int`,
    })
    .from(appSeconds)
    .where(sql`${appSeconds.day} between ${from} and ${to}`)
    .groupBy(appSeconds.day, appSeconds.app)
    .orderBy(appSeconds.day))();
  asked.set(tx, { from, to, rows });
  return rows;
}

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
  return async ({ from, to, tx }) => {
    const rows = await rowsOf(tx, from, to);
    return minutesPerDay(rows, source.apps).map((one) => ({
      day: one.day,
      quantity: one.minutes,
      unit: UNIT,
      labelKey: source.labelKey,
    }));
  };
}

export const TIMELOG_UNIT = UNIT;
