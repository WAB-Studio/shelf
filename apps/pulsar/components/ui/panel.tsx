import type { ReactNode } from "react";

import styles from "./panel.module.css";

// The desktop card that groups one part of a screen (RNP-17): white ground,
// 1px line, radius 14. Below 1024px it draws nothing, so the phone face is the
// page's own column. Stack panels as siblings: the column's gap sets the space between them.
export function Panel({
  children,
  as: Tag = "section",
  row = false,
  bordered = false,
  stacked = false,
  label,
  print,
}: {
  children?: ReactNode;
  as?: "section" | "div";
  // From 1024px a plain row of its children, no card: a title beside its acts.
  row?: boolean;
  // A box at every width, for a note that stands apart on the phone too.
  bordered?: boolean;
  // A plain block on the phone, its rows touching, so the phone face keeps its
  // own stacking; from 1024px the card, without the gap between rows.
  stacked?: boolean;
  label?: string;
  // `plain`: on paper no card, only what it holds.
  print?: "plain";
}) {
  const className = [
    styles.panel,
    row ? styles.row : undefined,
    bordered ? styles.bordered : undefined,
    stacked ? styles.stacked : undefined,
    print === "plain" ? styles.printPlain : undefined,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <Tag className={className} aria-label={label}>
      {children}
    </Tag>
  );
}

// Cards side by side from 1024px, tops aligned, two columns at every width;
// below, the children stay the parent's own items.
// `from="wide"`: side by side only from 1280px, for cards that share the
// screen with another column; below, one full-width card under the other.
// `print="stack"`: on paper one full-width column.
export function PanelGrid({ children, from, print }: { children: ReactNode; from?: "wide"; print?: "stack" }) {
  const className = [
    styles.grid,
    from === "wide" ? styles.fromWide : undefined,
    print === "stack" ? styles.printStack : undefined,
  ]
    .filter(Boolean)
    .join(" ");
  return <div className={className}>{children}</div>;
}
