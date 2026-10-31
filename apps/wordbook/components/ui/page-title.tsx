import type { ReactNode } from "react";

import styles from "./page-title.module.css";

// A screen's title: Fraunces 40 in ink on the ground. The green band is the main screen's brand block alone
// (docs/wordbook/DESIGN.md, decision of 2026-10-31).
export function PageTitle({ children }: { children?: ReactNode }) {
  return <h1 className={styles.title}>{children}</h1>;
}
