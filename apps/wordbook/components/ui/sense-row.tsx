import type { ReactNode } from "react";

import styles from "./sense-row.module.css";

// One sense of an entry, ruled from the next by a hairline and never boxed: its label and body on
// the left, its one action on the right (below the body on a phone).
export function SenseRow({ label, action, children }: { label: ReactNode; action?: ReactNode; children: ReactNode }) {
  return (
    <section className={styles.row}>
      <div className={styles.label}>{label}</div>
      {action !== undefined && <div className={styles.action}>{action}</div>}
      <div className={styles.body}>{children}</div>
    </section>
  );
}
