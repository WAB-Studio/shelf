import type { ReactNode } from "react";

import styles from "./page.module.css";

// The ground every screen stands on: one column, the phone's own gutter, and
// the room a home indicator takes under the last row.
//
// Beside the rail a screen without `width="full"` is a form: its header spans
// the frame and the fields sit in a 560px block under it. `width="full"` is
// for every screen that lays out its own columns or list, which take all the
// rail leaves.
//
// `width="column"` is `full` with a one-column screen's content held to 640
// from 1024 (docs/pulsar/DESIGN.md "The space system"), the header spanning.
//
// `alone` is a screen outside the shell, with no rail beside it (the consent
// screen): from 1024 its 640px column stays centred at the phone's padding.
// `middle` centres the column's content vertically on a screen that has one
// thing to say. `snug` closes the column's gap to the phone's 32 from 1024, for
// a screen that would otherwise outgrow the viewport.
export function Page({
  children,
  width,
  alone,
  middle,
  snug,
  print,
}: {
  children?: ReactNode;
  width?: "full" | "column";
  alone?: boolean;
  middle?: boolean;
  snug?: boolean;
  // `full`: on paper the column spans the sheet between its margins, whatever the screen's width.
  print?: "full";
}) {
  const cap = width === "full" ? styles.full : width === "column" ? `${styles.full} ${styles.column}` : undefined;
  const className = [styles.page, cap, alone ? styles.alone : undefined, middle ? styles.middle : undefined, snug ? styles.snug : undefined, print === "full" ? styles.printFull : undefined]
    .filter(Boolean)
    .join(" ");
  return <main className={className}>{children}</main>;
}
