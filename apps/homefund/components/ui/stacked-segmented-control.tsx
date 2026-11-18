"use client";

import type { ComponentProps } from "react";
import { SegmentedControl } from "@radix-ui/themes";

import styles from "./stacked-segmented-control.module.css";

// Radix Themes' own stylesheet sets `min-width: max-content` on the root,
// so a two-option control can never shrink narrower than both labels on
// one line.
// `wrap` lets the pills fall onto a second line on a phone instead of scrolling, for a short set whose last
// label would otherwise sit half off the edge.
function Root({
  wrap,
  ...props
}: ComponentProps<typeof SegmentedControl.Root> & { wrap?: boolean }) {
  return (
    <SegmentedControl.Root
      {...props}
      className={wrap ? `${styles.root} ${styles.wrap}` : styles.root}
    />
  );
}

function Item(props: ComponentProps<typeof SegmentedControl.Item>) {
  return <SegmentedControl.Item {...props} className={styles.item} />;
}

export const StackedSegmentedControl = { Root, Item };
