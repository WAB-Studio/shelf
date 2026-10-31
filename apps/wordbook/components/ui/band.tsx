import type { ReactNode } from "react";

import styles from "./band.module.css";

// A screen's title on a smaller bottle-green band: the brand block's little sibling, so every
// screen carries the colour the main one introduces (docs/wordbook/DESIGN.md "Verde botella").
export function Band({ children }: { children?: ReactNode }) {
  return (
    <div className={styles.band}>
      <h1 className={styles.title}>{children}</h1>
    </div>
  );
}
