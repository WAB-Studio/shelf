import type { ReactNode } from "react";
import { Flex } from "@radix-ui/themes";

import { BottomNav } from "./bottom-nav";
import styles from "./page.module.css";

// The thumb-zone reserve every screen shares, ahead of the box that will sit in
// it: only the safe-area inset below `p="6"` is new here. The bar itself
// (docs/wordbook/DESIGN.md "Viewport") is fixed outside this element, so its
// own height is reserved in `.page`'s padding rather than pushed by flow.
export function Page({
  children,
  // `"reading"` caps the measure at 620px above 660px, the default every
  // prose screen keeps. `"full"` drops the cap for a list or a set of
  // controls (docs/wordbook/DESIGN.md "Viewport": Registro, Cuenta and
  // Dispositivos take the width they need, decided 2026-09-08).
  measure = "reading",
  // A column beside the screen from 1024px up, where the reading measure would leave the desktop
  // empty; it is never drawn on the phone.
  aside,
}: {
  children?: ReactNode;
  measure?: "reading" | "full";
  aside?: ReactNode;
}) {
  const full = measure === "full";
  const className = [styles.page, full ? styles.full : undefined, aside === undefined ? undefined : styles.withAside]
    .filter(Boolean)
    .join(" ");
  return (
    <>
      <Flex asChild direction="column" flexGrow="1" p="6" className={className}>
        <main>
          {aside === undefined ? (
            children
          ) : (
            <div className={styles.columns}>
              <div className={styles.body} data-reading-column="">
                {children}
              </div>
              <aside className={styles.aside}>{aside}</aside>
            </div>
          )}
        </main>
      </Flex>
      <BottomNav />
    </>
  );
}
