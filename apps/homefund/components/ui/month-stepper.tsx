"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { Flex, Text } from "@radix-ui/themes";

import { IconButton } from "./button";

// The month a screen reads, with a step to each side: Presupuestos and Reportes
// both put it between their tabs and their figures. The caller owns the month and
// the way it changes; this only draws it.
export function MonthStepper({
  label,
  previousLabel,
  nextLabel,
  onPrevious,
  onNext,
  nextDisabled,
}: {
  label: string;
  previousLabel: string;
  nextLabel: string;
  onPrevious: () => void;
  onNext: () => void;
  nextDisabled?: boolean;
}) {
  return (
    <Flex align="center" justify="center" gap="4" width="100%">
      <IconButton
        type="button"
        variant="ghost"
        color="gray"
        size="3"
        aria-label={previousLabel}
        onClick={onPrevious}
      >
        <ChevronLeft size={18} />
      </IconButton>
      <Text weight="bold">{label}</Text>
      <IconButton
        type="button"
        variant="ghost"
        color="gray"
        size="3"
        aria-label={nextLabel}
        disabled={nextDisabled}
        onClick={onNext}
      >
        <ChevronRight size={18} />
      </IconButton>
    </Flex>
  );
}
