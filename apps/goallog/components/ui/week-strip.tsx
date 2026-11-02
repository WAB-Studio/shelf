import type { CSSProperties } from "react";

import styles from "./week-strip.module.css";

export type WeekStripDay = {
  key: string;
  // «lun».
  label: string;
  // «lunes 26», for a screen reader.
  name: string;
  // How much of what the day asked is done, 0 to 100.
  percent: number;
  // A day that asked nothing draws a dot, no bar.
  none?: boolean;
  today?: boolean;
  // «5/7», under the bar.
  figure?: string;
};

// docs/goallog/DESIGN.md «Hoy»: the week as seven slim columns, each a bar filled to the share of the day
// done, today on a soft fill. One hue, the accent; height tells the days apart.
export function WeekStrip({ label, days }: { label: string; days: readonly WeekStripDay[] }) {
  return (
    <ol className={styles.strip} aria-label={label} data-part="week-strip">
      {days.map((day) => (
        <li key={day.key} className={day.today ? `${styles.day} ${styles.today}` : styles.day} aria-label={day.figure ? `${day.name}: ${day.figure}` : day.name} aria-current={day.today ? "date" : undefined}>
          <span className={styles.label}>{day.label}</span>
          {day.none ? (
            <span className={styles.none} />
          ) : (
            <span className={styles.track}>
              <span className={styles.fill} style={{ "--share": `${day.percent}%` } as CSSProperties} />
            </span>
          )}
          <span className={styles.figure}>{day.figure}</span>
        </li>
      ))}
    </ol>
  );
}
