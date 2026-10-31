import type { ReactNode } from "react";
import { BookOpen } from "lucide-react";

import styles from "./wordmark.module.css";

// The lockup: the book glyph, then the name in Fraunces. `children` is the translated name with a
// `<mark>` around «Book», which the stylesheet sets on the marigold highlight, spaced off the «d».
export function Wordmark({ children, size = "md" }: { children: ReactNode; size?: "md" | "lg" }) {
  return (
    <span className={size === "lg" ? `${styles.mark} ${styles.lg}` : styles.mark}>
      <BookOpen className={styles.icon} aria-hidden="true" strokeWidth={1.75} />
      <span>{children}</span>
    </span>
  );
}
