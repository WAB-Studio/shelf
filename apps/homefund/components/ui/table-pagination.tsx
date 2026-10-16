"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { Flex, IconButton } from "@radix-ui/themes";

import styles from "./table-pagination.module.css";

/**
 * The foot of a dense table (RF-48, RNF-08). State never lives here: the caller
 * owns the page index, builds the caption from its own ICU message and withholds
 * the handler at either end — the button then reads disabled instead of
 * disappearing, so the control never moves under the pointer.
 */
export function TablePagination({
  caption,
  onPrev,
  onNext,
  prevLabel,
  nextLabel,
}: {
  caption: string;
  onPrev?: () => void;
  onNext?: () => void;
  prevLabel: string;
  nextLabel: string;
}) {
  return (
    <Flex align="center" justify="between" gap="3" className={styles.pagination}>
      <span className={styles.caption}>{caption}</span>
      <Flex align="center" gap="2">
        <IconButton
          type="button"
          variant="surface"
          color="gray"
          className={styles.step}
          aria-label={prevLabel}
          disabled={!onPrev}
          onClick={onPrev}
        >
          <ChevronLeft size={14} />
        </IconButton>
        <IconButton
          type="button"
          variant="surface"
          color="gray"
          className={styles.step}
          aria-label={nextLabel}
          disabled={!onNext}
          onClick={onNext}
        >
          <ChevronRight size={14} />
        </IconButton>
      </Flex>
    </Flex>
  );
}
