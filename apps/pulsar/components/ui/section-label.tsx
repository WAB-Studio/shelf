import type { ReactNode } from "react";

import styles from "./section-label.module.css";

// docs/pulsar/DESIGN.md "Type": the label that names a goal or a group, never
// a state. Its own element rather than a `Text` variant, because it is the one
// role in the scale that also sets case and tracking.
// `printSuffix` joins the label after « · » on paper alone. It is drawn from a pseudo-element, so the label's text on screen stays the label.
export function SectionLabel({ children, printSuffix }: { children?: ReactNode; printSuffix?: string }) {
  return (
    <span className={styles.label} data-part="section-label" data-print-suffix={printSuffix ? ` · ${printSuffix}` : undefined}>
      {children}
    </span>
  );
}
