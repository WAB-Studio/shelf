import { Check } from "lucide-react";

import styles from "./mark.module.css";

// docs/goallog/DESIGN.md "The marks": one shape, four states. `evidence` is a
// day another app wrote, and it never reads as one the person declared (RP-09).
export type MarkState = "declared" | "evidence" | "empty" | "partial";

// `declared` is the only state with no ring: it is the accent filled.
const states: Record<MarkState, string> = {
  declared: styles.declared,
  evidence: `${styles.evidence} ${styles.ring}`,
  empty: `${styles.empty} ${styles.ring}`,
  partial: `${styles.partial} ${styles.ring}`,
};

export function Mark({
  state,
  dashed,
  label,
  size = "row",
  quiet,
}: {
  state: MarkState;
  // The one dashed stroke in the design: the row nothing has written yet
  // (docs/goallog/DESIGN.md "Decisions taken here").
  dashed?: boolean;
  // Names the mark when it stands on its own, in a grid of days. Inside a row
  // the row's own text already says it, so the mark stays out of the tree.
  label?: string;
  // `row` is the 24px mark at the head of a day's row, with a check inside a
  // filled or evidence state. `dot` is Meta.dc.html's 8px phase mark — the
  // same filled/outlined shape, standing on its own with no check, since a
  // phase is never "satisfied", only in effect or not (RP-15).
  size?: "row" | "dot";
  // A declared check with no accent: a commitment already met in its period
  // (`HoyCuenta.dc.html`), done for now and asking nothing today.
  quiet?: boolean;
}) {
  const className = [
    styles.mark,
    states[state],
    dashed ? styles.dashed : undefined,
    quiet ? styles.quiet : undefined,
    size === "dot" ? styles.dot : undefined,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <span
      className={className}
      data-part="mark"
      data-state={state}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {size === "row" && state !== "empty" && state !== "partial" ? (
        <Check className={styles.check} strokeWidth={3} />
      ) : null}
    </span>
  );
}
