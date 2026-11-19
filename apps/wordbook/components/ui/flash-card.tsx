import type { ReactNode } from "react";

import styles from "./flash-card.module.css";

// The review's card: one entry centred on a surface of fixed proportions. Each `face` turns in when it
// first shows (a flip, unless the reader asked for less motion); the back may grow past the ratio.
//
// `centred`: from 1024px the card fills the column it is given instead of keeping its ratio, with a
// rounder corner and more air around what it holds.
export function FlashCard({ face, centred, children }: { face: "front" | "back"; centred?: boolean; children?: ReactNode }) {
  return (
    <section className={centred ? `${styles.card} ${styles.centred}` : styles.card}>
      <div key={face} className={styles.face}>
        {children}
      </div>
    </section>
  );
}

// What the reader presses under the card. On a phone it is fixed above the bottom bar, in the thumb's
// reach; from 1024px it sits under the card in the flow.
export function ActionBar({ children }: { children?: ReactNode }) {
  return (
    <>
      <div className={styles.bar}>{children}</div>
      <div className={styles.spacer} aria-hidden="true" />
    </>
  );
}
