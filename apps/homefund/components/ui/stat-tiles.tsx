import type { ReactNode } from "react";

import styles from "./stat-tiles.module.css";

/**
 * The row of figures a screen opens with when it has no repeating rows to show
 * (RF-83, RF-88, RF-48): equal-width cards, each a caps label over one figure and
 * an optional note. The value arrives formatted — `Money` is what a caller passes.
 */
export function StatTiles({
  tiles,
}: {
  tiles: {
    key: string;
    label: string;
    value: ReactNode;
    note?: ReactNode;
    tone?: "plain" | "warn" | "danger";
  }[];
}) {
  return (
    <div className={styles.tiles}>
      {tiles.map((tile) => (
        <div
          key={tile.key}
          className={styles.tile}
          data-tone={tile.tone === "plain" ? undefined : tile.tone}
        >
          <span className={styles.label}>{tile.label}</span>
          <span className={styles.value}>{tile.value}</span>
          {tile.note && <span className={styles.note}>{tile.note}</span>}
        </div>
      ))}
    </div>
  );
}
