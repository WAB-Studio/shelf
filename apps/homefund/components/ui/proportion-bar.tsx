import styles from "./proportion-bar.module.css";

export type ProportionSegment = {
  key: string;
  // A share of the bar: any non-negative number, read against `total` or the sum.
  value: number;
  color: string;
};

/**
 * One horizontal bar split into segments by their share, drawn in the colours the
 * caller names. With `total` the segments fill only their part of it and the track
 * shows the rest (a meter); without it they fill the bar (a composition). The
 * caller owns every label: the bar itself only announces `aria-label`.
 */
export function ProportionBar({
  segments,
  total,
  height = 12,
  "aria-label": ariaLabel,
}: {
  segments: ProportionSegment[];
  total?: number;
  height?: number;
  "aria-label": string;
}) {
  const sum = segments.reduce((acc, segment) => acc + segment.value, 0);
  const base = Math.max(total ?? sum, sum, 1);

  return (
    <div
      role="img"
      aria-label={ariaLabel}
      className={styles.bar}
      style={{ height }}
    >
      {segments
        .filter((segment) => segment.value > 0)
        .map((segment) => (
          <span
            key={segment.key}
            className={styles.segment}
            style={{
              width: `${(segment.value / base) * 100}%`,
              backgroundColor: segment.color,
            }}
          />
        ))}
    </div>
  );
}
