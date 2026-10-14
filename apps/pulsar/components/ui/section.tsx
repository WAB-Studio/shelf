import { Children, type ReactNode } from "react";

import { SectionLabel } from "./section-label";
import styles from "./section.module.css";

// docs/pulsar/DESIGN.md "Decisions of 2026-10-06": a section carries its own
// label→content gap. The gap to the next section is the parent's `gap`, so a
// screen never spaces sections with a margin.
export function Section({
  label,
  printSuffix,
  as: Tag = "section",
  repeatLabel,
  children,
}: {
  label?: ReactNode;
  printSuffix?: string;
  as?: "section" | "div";
  // Paper repeats the label on each sheet the section runs onto.
  repeatLabel?: boolean;
  children?: ReactNode;
}) {
  return (
    <Tag className={styles.section}>
      {repeatLabel ? (
        <table className={styles.repeat}>
          <thead>
            <tr>
              <th scope="col">{label ? <SectionLabel printSuffix={printSuffix}>{label}</SectionLabel> : null}</th>
            </tr>
          </thead>
          <tbody>
            {Children.map(children, (child) => (
              <tr>
                <td>{child}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <>
          {label ? <SectionLabel printSuffix={printSuffix}>{label}</SectionLabel> : null}
          {children}
        </>
      )}
    </Tag>
  );
}
