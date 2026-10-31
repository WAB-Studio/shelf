import type { Timeline as TimelineShape } from "@/lib/goals/timeline";

import styles from "./timeline.module.css";

// docs/goallog/DESIGN.md «Decisión del 2026-10-31»: a goal's span as one track, each phase a segment (the one in
// effect in the accent, the ones lived in ink, the ones to come as a stroke) and «hoy» a mark on it.
export function Timeline({
  line,
  label,
  today,
  from,
  to,
}: {
  line: TimelineShape;
  label: string;
  today: string;
  from: string;
  to: string;
}) {
  return (
    <span className={styles.timeline} data-part="timeline">
      <span className={styles.track} role="img" aria-label={label}>
        {line.segments.map((segment) => (
          <span
            key={segment.id}
            className={`${styles.segment} ${styles[segment.state]}`}
            style={{ insetInlineStart: `${segment.left}%`, inlineSize: `${segment.width}%` }}
            title={segment.name}
          />
        ))}
        {line.today !== null ? (
          <span className={styles.today} style={{ insetInlineStart: `${line.today}%` }}>
            <span className={styles.todayLabel}>{today}</span>
          </span>
        ) : null}
      </span>
      <span className={styles.ends} aria-hidden>
        <span>{from}</span>
        <span>{to}</span>
      </span>
    </span>
  );
}
