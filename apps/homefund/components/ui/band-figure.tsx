"use client";

import type { CSSProperties } from "react";
import { Heading } from "@radix-ui/themes";

import { Money, type MoneyProps, useMoneyFigure } from "./money";
import styles from "./summary-band.module.css";

// A headline figure that grows to 40px from `md`. The featured card shrinks a
// long one to its width by the characters it draws.
export function BandFigure(props: Omit<MoneyProps, "size">) {
  const length = useMoneyFigure(props).length;

  return (
    <Heading
      size="8"
      className={styles.figure}
      style={{ "--figure-length": length } as CSSProperties}
    >
      <Money {...props} size="inherit" />
    </Heading>
  );
}
