import type { ComponentProps, ReactNode } from "react";
import { Flex, Heading, Theme } from "@radix-ui/themes";

import styles from "./summary-band.module.css";

// The three grow factors of the Inicio artboard, as the card a ratio stands for.
type BandRatio = 1.35 | 1 | 0.9;

type DataAttributes = { [key: `data-${string}`]: string | number | undefined };

/**
 * The dashboard's row of cards. Below `md` it and its cards are not boxes, so
 * their content stays in the column above; from `md` they are one flex row.
 */
export function SummaryBand({
  children,
  ...props
}: ComponentProps<typeof Flex> & DataAttributes) {
  return (
    <Flex direction="column" gap="4" {...props} className={styles.summary}>
      {children}
    </Flex>
  );
}

export function BandCards({ children }: { children: ReactNode }) {
  return <div className={styles.cards}>{children}</div>;
}

/**
 * One card of the band. `ratio` is its share of the row from `md`;
 * `hideBelowMd` drops it from the phone, where its content lives elsewhere.
 * Any `data-*` attribute reaches the element.
 */
export function BandCard({
  ratio,
  hideBelowMd,
  centered,
  featured,
  children,
  ...data
}: {
  ratio: BandRatio;
  hideBelowMd?: boolean;
  // Centres the content on the card's cross axis from `md`.
  centered?: boolean;
  // The brand block: a box at every width, deep ink with its figure in lime.
  // Its content reads the dark tokens, so gray labels and badges keep their contrast.
  featured?: boolean;
  children?: ReactNode;
} & DataAttributes) {
  return (
    <div
      {...data}
      className={styles.card}
      data-ratio={ratio}
      data-hide-below-md={hideBelowMd ? "" : undefined}
      data-centered={centered ? "" : undefined}
      data-featured={featured ? "" : undefined}
    >
      {featured ? (
        <Theme appearance="dark" hasBackground={false}>
          {children}
        </Theme>
      ) : (
        children
      )}
    </div>
  );
}

// A headline figure that grows to 40px from `md`.
export function BandFigure({ children }: { children: ReactNode }) {
  return (
    <Heading size="8" className={styles.figure}>
      {children}
    </Heading>
  );
}

/** A card's figures side by side; four of them wrap into a grid instead. */
export function BandStats({
  count,
  children,
}: {
  count: 3 | 4;
  children: ReactNode;
}) {
  return (
    <Flex gap="4" wrap="wrap" className={styles.stats} data-stats={count}>
      {children}
    </Flex>
  );
}

// A standalone report card, shown from `md` only (its parent is hidden below).
export function ReportCard({ children }: { children: ReactNode }) {
  return <div className={styles.reportCard}>{children}</div>;
}

// Two report cards side by side: the wider share goes to the first.
export function ReportRow({ children }: { children: ReactNode }) {
  return <div className={styles.reportRow}>{children}</div>;
}
