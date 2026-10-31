import type { ReactNode } from "react";

import styles from "./highlight.module.css";

// The marigold behind a key word: a headline's, or the word an example is about.
export function Highlight({ children }: { children?: ReactNode }) {
  return <mark className={styles.mark}>{children}</mark>;
}
