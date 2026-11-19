import type { ReactNode } from "react";

import styles from "./wordmark.module.css";

// The name alone, in Fraunces 700: no glyph, no highlight.
export function Wordmark({ children }: { children: ReactNode }) {
  return <span className={styles.mark}>{children}</span>;
}
