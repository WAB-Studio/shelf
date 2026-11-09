import { minutesPerDay, TIMELOG_SOURCES } from "./timelog-apps";
import { readableApp } from "./timelog-names";

export type TimelogRow = { day: string; app: string; seconds: number };
export type TimelogEntry = { id: string; day: string; minutes: number; waiting: boolean };
export type TrayStep =
  | { kind: "insert"; day: string; minutes: number }
  | { kind: "set"; id: string; minutes: number }
  | { kind: "delete"; id: string };

/**
 * The TimeLog minutes per day no commitment counts as evidence (RP-146, RP-151). A commitment on a source already
 * satisfies its day with those minutes, so they must not also reach a goal through an allocation: only what is left
 * goes to the tray. `covered` are the source keys of the live TimeLog commitments; the day's total covers everything.
 */
export function uncoveredMinutes(rows: readonly TimelogRow[], covered: readonly string[]): { day: string; minutes: number }[] {
  const named = new Set<string>();
  for (const source of TIMELOG_SOURCES) {
    if (!covered.includes(source.key)) continue;
    if (source.apps === null) return [];
    for (const app of source.apps) named.add(app);
  }
  return minutesPerDay(
    rows.filter((row) => !named.has(readableApp(row.app) ?? "")),
    null,
  );
}

/**
 * What to write so each day's TimeLog entries add up to `wanted`, never two entries for the same minutes: minutes
 * the person already placed or dismissed stay accounted for, and only the difference moves the waiting entry (or
 * opens a new one when none waits).
 */
export function planTrayEntries(wanted: readonly { day: string; minutes: number }[], entries: readonly TimelogEntry[]): TrayStep[] {
  const days = new Set([...wanted.map((one) => one.day), ...entries.map((one) => one.day)]);
  const steps: TrayStep[] = [];
  for (const day of [...days].sort()) {
    const mine = entries.filter((one) => one.day === day);
    const accounted = mine.reduce((total, one) => total + one.minutes, 0);
    const delta = (wanted.find((one) => one.day === day)?.minutes ?? 0) - accounted;
    if (delta === 0) continue;
    const waiting = mine.find((one) => one.waiting);
    if (!waiting) {
      if (delta > 0) steps.push({ kind: "insert", day, minutes: delta });
      continue;
    }
    const minutes = waiting.minutes + delta;
    steps.push(minutes >= 1 ? { kind: "set", id: waiting.id, minutes } : { kind: "delete", id: waiting.id });
  }
  return steps;
}
