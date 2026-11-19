import type { ReactNode } from "react";

import styles from "./page-title.module.css";

// A screen's title: Fraunces 40 in ink on the ground. The green band is the main screen's brand block alone
//.
export function PageTitle({ children, size }: { children?: ReactNode; size?: "compact" }) {
  return <h1 className={size === "compact" ? `${styles.title} ${styles.compact}` : styles.title}>{children}</h1>;
}
