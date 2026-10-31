import type { ReactNode } from "react";

import { Wordmark } from "./wordmark";
import styles from "./brand-block.module.css";

// The main screen's brand block (docs/wordbook/DESIGN.md "Verde botella"):
// `title` carries a `<mark>` around its key word, which the stylesheet sets on
// the marigold highlight. The sidebar already carries the name from 1024px, so
// the block drops its own there. `compact` keeps the search box alone, for a
// screen that has an answer to show and wants it near the top.
export function BrandBlock({
  title,
  line,
  compact,
  children,
}: {
  title: ReactNode;
  line: string;
  compact?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className={compact ? `${styles.block} ${styles.compact}` : styles.block}>
      {!compact && (
        <>
          <p className={styles.title}>
            <Wordmark size="lg">{title}</Wordmark>
          </p>
          <p className={styles.line}>{line}</p>
        </>
      )}
      {children}
    </div>
  );
}
