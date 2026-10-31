import type { ReactNode } from "react";

import styles from "./week-bars.module.css";

export type WeekBar = {
  key: string;
  // «semana 6», and the dates under it.
  label: string;
  detail?: string;
  // The week's total, drawn at the bar's end.
  total: ReactNode;
  // Length of the bar, 0 to 100, against the longest week shown.
  percent: number;
  // Where the plan's weekly pace falls on the same scale; null with no rhythm.
  plan: number | null;
  current?: boolean;
  // «en curso»: said after the dates on the current week, as a mark and never a column.
  mark?: string;
  // The phase in effect that week, named on the first row of its run.
  phase?: string;
  phaseRun: "start" | "middle" | "end" | "only" | null;
};

// docs/goallog/DESIGN.md «Decisión del 2026-10-31»: the weeks of a goal as horizontal bars, one per week, with a mark
// where the plan puts the pace and a rule down the side for the phase in effect. The total is always printed.
export function WeekBars({ caption, bars, planLabel }: { caption: string; bars: readonly WeekBar[]; planLabel?: string }) {
  return (
    <ol className={styles.list} aria-label={caption} data-part="week-bars">
      {bars.map((bar) => (
        <li key={bar.key} className={bar.current ? `${styles.row} ${styles.current}` : styles.row} aria-current={bar.current ? "true" : undefined} data-current={bar.current ? "" : undefined}>
          <span className={bar.phaseRun ? `${styles.rule} ${styles[bar.phaseRun]}` : styles.rule} aria-hidden />
          <span className={styles.label}>
            <span className={styles.name}>{bar.label}</span>
            {bar.detail ? <span className={styles.detail}>{bar.mark ? `${bar.detail} · ${bar.mark}` : bar.detail}</span> : null}
            {bar.phase ? <span className={styles.phase}>{bar.phase}</span> : null}
          </span>
          <span className={styles.track} aria-hidden>
            <span className={styles.bar} style={{ inlineSize: `${bar.percent}%` }} />
            {bar.plan !== null ? <span className={styles.plan} style={{ insetInlineStart: `${bar.plan}%` }} title={planLabel} /> : null}
          </span>
          <span className={styles.total}>{bar.total}</span>
        </li>
      ))}
    </ol>
  );
}
