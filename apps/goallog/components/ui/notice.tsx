import { forwardRef, type ReactNode } from "react";

import styles from "./notice.module.css";

// docs/pulsar/DESIGN.md "Importar": a refusal the person must read, as a
// white box with a 1.5px ink ring — this design has no colour for failure.
// `note` is a line to read where it stands, not announced as a failure.
// `title` and `rows` list several things at once: a bold line, then one row each, a rule between.
// `onRow` makes each row a button of 44px or more; `current` tints the one last pressed.
// `aside` is a grey line under the rows; `focusable` lets the box take focus from code.
type NoticeProps = {
  children?: ReactNode;
  role?: "alert" | "note";
  title?: string;
  rows?: string[];
  onRow?: (index: number) => void;
  current?: number | null;
  aside?: string;
  focusable?: boolean;
};

export const Notice = forwardRef<HTMLDivElement, NoticeProps>(function Notice(
  { children, role = "alert", title, rows, onRow, current, aside, focusable },
  ref,
) {
  return (
    <div ref={ref} role={role} tabIndex={focusable ? -1 : undefined} className={styles.notice}>
      {title ? <strong className={styles.title}>{title}</strong> : null}
      {rows?.map((row, index) =>
        onRow ? (
          <button
            key={index}
            type="button"
            className={`${styles.row} ${styles.pressable}`}
            aria-current={current === index ? "true" : undefined}
            onClick={() => onRow(index)}
          >
            {row}
          </button>
        ) : (
          <p key={index} className={styles.row}>
            {row}
          </p>
        ),
      )}
      {aside ? <p className={styles.aside}>{aside}</p> : null}
      {children}
    </div>
  );
});
