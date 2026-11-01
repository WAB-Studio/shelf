import type { ReactNode } from "react";

import styles from "./tile.module.css";

// docs/goallog/DESIGN.md «Hoy, 2026-11-01»: a task on Hoy is a tile like a commitment, its mark on the same edge.
export function Tile({ children }: { children: ReactNode }) {
  return <div className={styles.tile}>{children}</div>;
}
