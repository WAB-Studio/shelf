import type { ReactNode } from "react";

import styles from "./highlight.module.css";

// One word of a line set on the brand's lime, in ink.
export function Highlight({ children }: { children: ReactNode }) {
  return <mark className={styles.highlight}>{children}</mark>;
}
