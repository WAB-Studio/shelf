import type { ReactNode } from "react";

import styles from "./flash-card.module.css";

// The review's card: one entry centred on a surface of fixed proportions. Each `face` turns in when it
// first shows (a flip, unless the reader asked for less motion); the back may grow past the ratio.
export function FlashCard({ face, children }: { face: "front" | "back"; children?: ReactNode }) {
  return (
    <section className={styles.card}>
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
