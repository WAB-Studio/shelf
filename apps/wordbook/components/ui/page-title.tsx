import type { ReactNode } from "react";

import styles from "./page-title.module.css";

// A screen's title: Fraunces 40 in ink on the ground, with no band or brand block behind it.
export function PageTitle({ children, size }: { children?: ReactNode; size?: "compact" }) {
  return <h1 className={size === "compact" ? `${styles.title} ${styles.compact}` : styles.title}>{children}</h1>;
}
