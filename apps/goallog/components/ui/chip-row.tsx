import type { ReactNode } from "react";

import styles from "./chip-row.module.css";

// A row of chips that wraps by chip. `tight` is the seven weekday chips, which
// sit 4px apart; every other row keeps 8.
export function ChipRow({ tight, children }: { tight?: boolean; children: ReactNode }) {
  return <div className={[styles.row, tight ? styles.tight : undefined].filter(Boolean).join(" ")}>{children}</div>;
}
