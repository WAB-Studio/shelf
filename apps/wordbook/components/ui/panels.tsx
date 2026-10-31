import type { ReactNode } from "react";

import styles from "./panels.module.css";

// A screen in two panels from 1280px (docs/wordbook/DESIGN.md, decision of 2026-10-31): `top` and
// `children` stack on the left, `side` stays beside them, sticky. Below 1280px everything is one
// column in the order top, side, children; `sideOnPhone={false}` leaves the side out there.
export function Panels({
  top,
  side,
  sideOnPhone = true,
  sideLast = false,
  children,
}: {
  top?: ReactNode;
  side?: ReactNode;
  sideOnPhone?: boolean;
  // On a phone the side follows `children` instead of preceding them.
  sideLast?: boolean;
  children?: ReactNode;
}) {
  const hasSide = side !== undefined && side !== null && side !== false;
  const className = hasSide ? styles.panels : `${styles.panels} ${styles.solo}`;
  return (
    <div className={className}>
      <div className={styles.top}>{top}</div>
      {hasSide && <aside
          className={[styles.side, sideOnPhone ? undefined : styles.deskOnly, sideLast ? styles.sideLast : undefined]
            .filter(Boolean)
            .join(" ")}
        >{side}</aside>}
      <div className={styles.rest}>{children}</div>
    </div>
  );
}
