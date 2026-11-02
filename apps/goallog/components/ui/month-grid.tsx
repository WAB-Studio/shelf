import Link from "next/link";

import type { GridDay } from "@/lib/day/month-grid";

import styles from "./month-grid.module.css";

// docs/goallog/DESIGN.md «Decisión del 2026-10-31»: the month as weeks of seven days, each day a tile whose fill
// grows with what was done in it. The number is always printed, so the fill is a second cue, never the only one.
// It sits in the navy block, which re-speaks the accent as sky. A day up to today opens that day; one still to come is
// plain. A legend under the grid says what a shade means.
export function MonthGrid({
  weeks,
  weekdays,
  today,
  label,
  dayLabel,
  legend,
}: {
  weeks: readonly (readonly GridDay[])[];
  // Monday first.
  weekdays: readonly string[];
  today: string;
  label: string;
  // Names one day for a screen reader: «30 de octubre, 3 hechos».
  dayLabel: (day: GridDay) => string;
  // «menos» and «más» at the ends of the four shades, and the sentence that says what they are.
  legend: { less: string; more: string; note: string };
}) {
  return (
    <>
      <div className={styles.grid} role="group" aria-label={label} data-part="month-grid">
        {weekdays.map((name) => (
          <span key={name} className={styles.head}>
            {name}
          </span>
        ))}
        {weeks.flat().map((cell) => {
          const classes = [styles.cell, styles[`level${cell.level}`], cell.inMonth ? undefined : styles.out, cell.day === today ? styles.today : undefined]
            .filter(Boolean)
            .join(" ");
          const number = Number(cell.day.slice(8, 10));
          if (cell.inMonth && cell.day <= today) {
            return (
              <Link
                key={cell.day}
                href={cell.day === today ? "/" : `/dia/${cell.day}`}
                className={`${classes} ${styles.link}`}
                aria-label={dayLabel(cell)}
                data-level={cell.level}
                data-day={cell.day}
              >
                {number}
              </Link>
            );
          }
          return (
            <span
              key={cell.day}
              className={classes}
              role={cell.inMonth ? "img" : undefined}
              aria-label={cell.inMonth ? dayLabel(cell) : undefined}
              aria-hidden={cell.inMonth ? undefined : true}
              data-level={cell.level}
            >
              {number}
            </span>
          );
        })}
      </div>
      <div className={styles.legend} data-part="month-legend">
        <span className={styles.legendEnd}>{legend.less}</span>
        {([0, 1, 2, 3, 4] as const).map((level) => (
          <span key={level} className={`${styles.swatch} ${styles[`level${level}`]}`} aria-hidden />
        ))}
        <span className={styles.legendEnd}>{legend.more}</span>
      </div>
      <p className={styles.legendNote}>{legend.note}</p>
    </>
  );
}
