import type { ReactNode } from "react";

import { Mark, type MarkState } from "./mark";

import styles from "./hero.module.css";

// docs/goallog/DESIGN.md "Naranja y marino": the one navy block a main screen
// holds, carrying the figure of the day or of the goal in the title face, with a
// bar or a line under it. It re-speaks the tokens inside, so what a screen
// draws in it (a `Progress`, a `Figure`) stays on a token.
export function Hero({
  label,
  figure,
  caption,
  highlight,
  days,
  children,
}: {
  label?: string;
  figure: ReactNode;
  caption?: ReactNode;
  // The key figure in sky (docs/goallog/DESIGN.md «Decisión del 2026-10-31»): only here, on the navy.
  highlight?: boolean;
  // The seven days of the week under the figure, each a mark of how the day went: `none` asked nothing.
  days?: { key: string; label: string; name: string; state: MarkState | "none"; figure?: string; today?: boolean }[];
  children?: ReactNode;
}) {
  return (
    <section className={styles.hero} data-part="hero" aria-label={label}>
      {label ? <span className={styles.label}>{label}</span> : null}
      <span className={highlight ? `${styles.figure} ${styles.highlight}` : styles.figure} data-part="hero-figure">
        {figure}
      </span>
      {caption ? <span className={styles.caption}>{caption}</span> : null}
      {children}
      {days ? (
        <ol className={styles.days} data-part="hero-days">
          {days.map((day) => (
            <li key={day.key} className={day.today ? `${styles.day} ${styles.dayToday}` : styles.day} aria-label={day.name}>
              <span className={styles.dayLabel}>{day.label}</span>
              {day.state === "none" ? <span className={styles.dayNone} /> : <Mark state={day.state} />}
              <span className={styles.dayFigure}>{day.figure}</span>
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}
