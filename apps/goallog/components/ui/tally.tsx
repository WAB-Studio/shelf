import type { ReactNode } from "react";

import styles from "./tally.module.css";

// docs/goallog/DESIGN.md «Hoy»: the day's progress beside its date, the count done in the title face and
// the rest of the sentence in Archivo. `label` is the whole sentence for a screen reader.
export function Tally({ done, rest, caption, label }: { done: ReactNode; rest: string; caption?: string; label: string }) {
  return (
    <span className={styles.tally} data-part="tally" role="group" aria-label={label}>
      <span className={styles.line} aria-hidden>
        <span className={styles.done}>{done}</span>
        <span className={styles.rest}>{rest}</span>
      </span>
      {caption ? (
        <span className={styles.caption} aria-hidden>
          {caption}
        </span>
      ) : null}
    </span>
  );
}
