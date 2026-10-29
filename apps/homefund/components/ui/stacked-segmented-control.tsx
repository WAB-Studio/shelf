"use client";

import type { ComponentProps } from "react";
import { SegmentedControl } from "@radix-ui/themes";

import styles from "./stacked-segmented-control.module.css";

// Radix Themes' own stylesheet sets `min-width: max-content` on the root,
// so a two-option control can never shrink narrower than both labels on
// one line.
function Root(props: ComponentProps<typeof SegmentedControl.Root>) {
  return <SegmentedControl.Root {...props} className={styles.root} />;
}

function Item(props: ComponentProps<typeof SegmentedControl.Item>) {
  return <SegmentedControl.Item {...props} className={styles.item} />;
}

export const StackedSegmentedControl = { Root, Item };
