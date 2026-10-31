import type { ReactNode } from "react";

import styles from "./card.module.css";

// The soft surface a screen's section sits on (docs/wordbook/DESIGN.md "Verde botella"):
// raised ground, a hairline, the shared radius and a low shadow. A sense is still ruled with a
// hairline, never boxed; this holds a whole section, not a line of one.
export function Card({
  children,
  padding = "4",
  tall,
}: {
  children?: ReactNode;
  // `"none"` for a list whose rows pad themselves.
  padding?: "none" | "3" | "4";
  // From 1024px the card takes the screen's height instead of hugging its lines.
  tall?: boolean;
}) {
  const base = padding === "4" ? styles.card : `${styles.card} ${padding === "3" ? styles.snug : styles.flush}`;
  const className = tall ? `${base} ${styles.tall}` : base;
  return <section className={className}>{children}</section>;
}
