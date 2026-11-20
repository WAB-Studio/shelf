import type { ReactNode } from "react";

import styles from "./pill-row.module.css";

// A line in a pill on the raised ground: a figure and its words on the left, one action on the right.
export function PillRow({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className={styles.row}>
      <span className={styles.text}>{children}</span>
      {action}
    </div>
  );
}
