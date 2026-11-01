import type { StripCell } from "@/lib/day/constancy";

import styles from "./strip.module.css";

// docs/goallog/DESIGN.md «Decisión del 2026-10-31»: thirty days of one commitment as thirty bars. A day done
// is a tall bar (declared: the accent filled; evidence: the soft fill with its ring); a day still open is a
// short stub; a day before the commitment was written is a dot. Height tells them apart as well as hue.
// It counts no streak and never says one broke.
// `full` is the commitment's own page, with its first day and «hoy» under it; `mini` is the goal's row; `row` is a
// commitment's row on Hoy, the width of the row.
export function Strip({
  cells,
  label,
  size = "full",
  from,
  to,
}: {
  cells: readonly StripCell[];
  // The strip's one name for a screen reader: «26 de 30 días».
  label: string;
  size?: "full" | "mini" | "row";
  from?: string;
  to?: string;
}) {
  return (
    <span className={size === "full" ? styles.strip : `${styles.strip} ${styles[size]}`} data-part="strip">
      <span className={styles.bars} role="img" aria-label={label}>
        {cells.map((cell) => (
          <span key={cell.day} className={`${styles.bar} ${styles[cell.state]}`} data-state={cell.state} />
        ))}
      </span>
      {size === "full" && from && to ? (
        <span className={styles.ends} aria-hidden>
          <span>{from}</span>
          <span>{to}</span>
        </span>
      ) : null}
    </span>
  );
}
