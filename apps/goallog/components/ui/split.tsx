import type { ReactNode } from "react";

import styles from "./split.module.css";

// The desktop screen's two columns (RNP-17): `main` on the left, `before` over
// `after` on the right. Below 768px the three parts are plain siblings in the
// page's own column, in the order `before`, `main`, `after`.
export function Split({
  main,
  before,
  after,
  tail,
  aside = 360,
  twoFifths = false,
  even = false,
  afterBelow = false,
  mainFirst = false,
  foot,
}: {
  main: ReactNode;
  before?: ReactNode;
  after?: ReactNode;
  // Sits under `main` in its column, but below `after` on a phone: the one
  // part whose place differs between the two layouts.
  tail?: ReactNode;
  // The right column's width: Hoy draws 360, the goal 380.
  aside?: 360 | 380;
  // Keeps the right column at two parts of five at every width from 768px,
  // where `aside` would fix it at a number of pixels from 1280.
  twoFifths?: boolean;
  // `main` alone, its children in two equal columns from 768: the past day
  // (`DiaPasadoEscritorio.dc.html`), which never narrows as the screen widens.
  even?: boolean;
  // From 768 `after` leaves the right column and stands under both, at the
  // content's full width: a part whose text needs more than the aside gives.
  afterBelow?: boolean;
  // On a phone `main` comes first, then `before`, `after` and `foot`: the part a person came for leads.
  mainFirst?: boolean;
  // What closes the screen under the split, at every width; with `mainFirst` it keeps last on a phone.
  foot?: ReactNode;
}) {
  const className = [
    styles.split,
    aside === 380 ? styles.asideWide : undefined,
    twoFifths ? styles.twoFifths : undefined,
    even ? styles.even : undefined,
    afterBelow ? styles.afterBelow : undefined,
    mainFirst ? styles.mainFirst : undefined,
    before ? undefined : styles.noBefore,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <>
    <div className={className}>
      {before ? <div className={styles.before} data-part="split-before">{before}</div> : null}
      <div className={styles.main} data-part="split-main">
        {main}
        {tail ? <div className={styles.tail} data-part="split-tail">{tail}</div> : null}
      </div>
      {after ? <div className={styles.after} data-part="split-after">{after}</div> : null}
    </div>
    {foot ? <div className={mainFirst ? `${styles.foot} ${styles.footLast}` : styles.foot} data-part="split-foot">{foot}</div> : null}
    </>
  );
}
