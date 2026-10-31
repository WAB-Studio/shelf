import type { ReactNode } from "react";

import { Wordmark } from "./wordmark";
import styles from "./brand-block.module.css";

// The main screen's brand block (docs/wordbook/DESIGN.md "Verde botella"):
// `title` carries a `<mark>` around its key word, which the stylesheet sets on
// the marigold highlight. The sidebar already carries the name from 1024px, so
// the block drops its own there. `line` is the one-sentence headline, its key word on the marigold. `compact` keeps the search box alone, for a
// screen that has an answer to show and wants it near the top.
export function BrandBlock({
  title,
  line,
  compact,
  children,
}: {
  title: ReactNode;
  line: ReactNode;
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
          <h1 className={styles.line}>{line}</h1>
        </>
      )}
      {children}
    </div>
  );
}
