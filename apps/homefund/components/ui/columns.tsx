import type { ReactNode } from "react";

import styles from "./columns.module.css";

/**
 * A desktop screen's reading columns. Below `md` the three areas stack in the
 * order `lead`, `aside`, `main`; from `md` the aside rides sticky beside the
 * other two; from 1600px the three stand side by side. An area left out leaves
 * no empty track.
 */
export function Columns({
  lead,
  main,
  aside,
}: {
  lead?: ReactNode;
  main?: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <div className={styles.columns} data-aside={aside ? "" : undefined}>
      {lead && <div className={styles.lead}>{lead}</div>}
      {aside && <aside className={styles.aside}>{aside}</aside>}
      {main && <div className={styles.main}>{main}</div>}
    </div>
  );
}
