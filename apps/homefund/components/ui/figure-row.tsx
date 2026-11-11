import type { ReactNode } from "react";
import { Flex } from "@radix-ui/themes";

import styles from "./figure-row.module.css";

// A lead (a disc, a date tile), the row's text and a figure on the right. The text
// never narrows below 7rem: past that the figure drops to its own line, still on
// the right, instead of squeezing the text or pushing the row out of its card.
export function FigureRow({
  lead,
  children,
  figure,
}: {
  lead: ReactNode;
  children: ReactNode;
  figure: ReactNode;
}) {
  return (
    <Flex align="center" gapX="3" gapY="1" wrap="wrap" className={styles.row}>
      {lead}
      <div className={styles.body}>{children}</div>
      <div className={styles.figure}>{figure}</div>
    </Flex>
  );
}
