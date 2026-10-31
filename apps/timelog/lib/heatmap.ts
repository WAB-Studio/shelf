import { appClass, type AppClass } from "@/lib/app-classes";
import { appName } from "@/lib/app-names";
import type { DayApp } from "@/lib/queries";

export const HEAT_LEVELS = 4;

export type HeatCell = { seconds: number; level: number };
export type HeatRow = { app: string; kind: AppClass; total: number; cells: HeatCell[] };
export type Heatmap = { rows: HeatRow[]; restCount: number; restSeconds: number };

// The week as a grid: the `top` apps of the week by total, a cell per day. An app is its readable name (two processes
// with one name add up, Windows' own noise is `systemName`). A cell's level, 1 to 4, is its share of the largest cell
// in the grid; a day with nothing is level 0.
export function buildHeatmap(rows: DayApp[], days: string[], systemName: string, top: number): Heatmap {
  const byApp = new Map<string, Map<string, number>>();
  for (const one of rows) {
    const name = appName(one.app, systemName);
    const mine = byApp.get(name) ?? new Map<string, number>();
    mine.set(one.day, (mine.get(one.day) ?? 0) + one.seconds);
    byApp.set(name, mine);
  }
  const apps = [...byApp]
    .map(([app, perDay]) => ({ app, perDay, total: [...perDay.values()].reduce((sum, seconds) => sum + seconds, 0) }))
    .sort((a, b) => b.total - a.total || a.app.localeCompare(b.app));
  const shown = apps.slice(0, top);
  const largest = Math.max(1, ...shown.flatMap((one) => days.map((day) => one.perDay.get(day) ?? 0)));
  const level = (seconds: number) => (seconds <= 0 ? 0 : Math.min(HEAT_LEVELS, Math.max(1, Math.ceil((seconds / largest) * HEAT_LEVELS))));
  const rest = apps.slice(top);
  return {
    rows: shown.map((one) => ({
      app: one.app,
      kind: appClass(one.app, systemName),
      total: one.total,
      cells: days.map((day) => {
        const seconds = one.perDay.get(day) ?? 0;
        return { seconds, level: level(seconds) };
      }),
    })),
    restCount: rest.length,
    restSeconds: rest.reduce((sum, one) => sum + one.total, 0),
  };
}
