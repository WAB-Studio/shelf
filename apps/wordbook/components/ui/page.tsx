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
}: {
  children?: ReactNode;
  // `"panels"` keeps the reading measure up to 1280px and from there hands the whole width to `Panels`.
  // `"margin"` does the same with the wider padding of the column-and-margin screen.
  // `"session"` centres a 680px column in what the sidebar leaves: the review, one card at a time.
  measure?: "reading" | "full" | "panels" | "margin" | "session";
}) {
  const className = [styles.page, measure === "full" ? styles.full : undefined, measure === "panels" ? styles.panels : undefined, measure === "margin" ? styles.margin : undefined, measure === "session" ? styles.session : undefined]
    .filter(Boolean)
    .join(" ");
  return (
    <>
      <Flex asChild direction="column" flexGrow="1" p="6" className={className}>
        <main>{children}</main>
      </Flex>
      <BottomNav />
    </>
  );
}
