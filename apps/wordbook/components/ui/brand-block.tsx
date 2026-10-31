import type { ReactNode } from "react";

import styles from "./brand-block.module.css";

// The main screen's brand block (docs/wordbook/DESIGN.md "Verde botella"):
// `title` carries a `<mark>` around its key word, which the stylesheet sets on
// the marigold highlight.
export function BrandBlock({
  title,
  line,
  children,
}: {
  title: ReactNode;
  line: string;
  children?: ReactNode;
}) {
  return (
    <div className={styles.block}>
      <p className={styles.title}>{title}</p>
      <p className={styles.line}>{line}</p>
      {children}
    </div>
  );
}
