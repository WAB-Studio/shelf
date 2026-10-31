import type { ReactNode } from "react";

import styles from "./panels.module.css";

// A screen in two panels from 1280px (docs/wordbook/DESIGN.md, decision of 2026-10-31): `top` and
// `children` stack on the left, `side` stays beside them, sticky. Below 1280px everything is one
// column in the order top, side, children; `sideOnPhone={false}` leaves the side out there.
export function Panels({
  top,
  side,
  sideOnPhone = true,
  children,
}: {
  top?: ReactNode;
  side?: ReactNode;
  sideOnPhone?: boolean;
  children?: ReactNode;
}) {
  const hasSide = side !== undefined && side !== null && side !== false;
  const className = hasSide ? styles.panels : `${styles.panels} ${styles.solo}`;
  return (
    <div className={className}>
      <div className={styles.top}>{top}</div>
      {hasSide && <aside className={sideOnPhone ? styles.side : `${styles.side} ${styles.deskOnly}`}>{side}</aside>}
      <div className={styles.rest}>{children}</div>
    </div>
  );
}
