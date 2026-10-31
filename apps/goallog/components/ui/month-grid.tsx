import type { GridDay } from "@/lib/day/month-grid";

import styles from "./month-grid.module.css";

// docs/goallog/DESIGN.md «Decisión del 2026-10-31»: the month as weeks of seven days, each day a tile whose fill
// grows with what was done in it. The number is always printed, so the fill is a second cue, never the only one.
// It sits in the navy block, which re-speaks the accent as sky.
export function MonthGrid({
  weeks,
  weekdays,
  today,
  label,
  dayLabel,
}: {
  weeks: readonly (readonly GridDay[])[];
  // Monday first.
  weekdays: readonly string[];
  today: string;
  label: string;
  // Names one day for a screen reader: «30 de octubre, 3 hechos».
  dayLabel: (day: GridDay) => string;
}) {
  return (
    <div className={styles.grid} role="group" aria-label={label} data-part="month-grid">
      {weekdays.map((name) => (
        <span key={name} className={styles.head}>
          {name}
        </span>
      ))}
      {weeks.flat().map((cell) => (
        <span
          key={cell.day}
          className={[styles.cell, styles[`level${cell.level}`], cell.inMonth ? undefined : styles.out, cell.day === today ? styles.today : undefined]
            .filter(Boolean)
            .join(" ")}
          role={cell.inMonth ? "img" : undefined}
          aria-label={cell.inMonth ? dayLabel(cell) : undefined}
          aria-hidden={cell.inMonth ? undefined : true}
          data-level={cell.level}
        >
          {Number(cell.day.slice(8, 10))}
        </span>
      ))}
    </div>
  );
}
