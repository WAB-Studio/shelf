import type { ReactNode } from "react";

import styles from "./panels.module.css";

// A screen in two panels from 1280px (docs/wordbook/DESIGN.md): `top` and
// `children` stack on the left, `side` stays beside them, sticky. Below 1280px everything is one
// column in the order top, side, children; `sideOnPhone={false}` leaves the side out there. A side that
// renders nothing leaves no panel and no gap; `reserveSide` keeps the panel anyway, for a screen whose
// layout must not move while its side is still to come.
export function Panels({
  top,
  side,
  sideOnPhone = true,
  sideLast = false,
  reserveSide = false,
  layout = "split",
  children,
}: {
  top?: ReactNode;
  side?: ReactNode;
  sideOnPhone?: boolean;
  // On a phone the side follows `children` instead of preceding them.
  sideLast?: boolean;
  reserveSide?: boolean;
  // `"margin"`: a 720px reading column and a 320px margin, 64px apart, with no card around the margin
  // (docs/wordbook/DESIGN.md «Gris frío y azul, columna y margen»).
  layout?: "split" | "margin";
  children?: ReactNode;
}) {
  const hasSide = reserveSide || (side !== undefined && side !== null && side !== false);
  const base = hasSide ? styles.panels : `${styles.panels} ${styles.solo}`;
  const className = layout === "margin" ? `${base} ${styles.margin}` : base;
  return (
    <div className={className}>
      <div className={styles.top}>{top}</div>
      {hasSide && <aside
          className={[styles.side, sideOnPhone ? undefined : styles.deskOnly, sideLast ? styles.sideLast : undefined, reserveSide ? styles.reserved : undefined]
            .filter(Boolean)
            .join(" ")}
        >{side}</aside>}
      <div className={styles.rest}>{children}</div>
    </div>
  );
}
