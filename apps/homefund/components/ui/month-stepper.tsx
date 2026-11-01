"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { Flex, Text } from "@radix-ui/themes";

import { addCivilMonths, civilDateToDate } from "@/lib/dates";

import { IconButton } from "./button";

// The month a screen reads (`YYYY-MM`), named and with a step to each side:
// Presupuestos and Reportes both put it between their tabs and their figures.
// The caller owns the month; this draws it and asks `onChange` for the next one.
export function MonthStepper({
  month,
  onChange,
  nextDisabled,
}: {
  month: string;
  onChange: (month: string) => void;
  nextDisabled?: boolean;
}) {
  const t = useTranslations("common");
  const format = useFormatter();
  const locale = useLocale();

  const anchor = `${month}-01`;
  const name = format.dateTime(civilDateToDate(anchor), { month: "long", year: "numeric" });
  // The month opens with a capital in the active language; the rest stays as written.
  const label = name.charAt(0).toLocaleUpperCase(locale) + name.slice(1);
  const step = (delta: number) => onChange(addCivilMonths(anchor, delta).slice(0, 7));

  return (
    <Flex align="center" justify="center" gap="4" width="100%">
      <IconButton
        type="button"
        variant="ghost"
        color="gray"
        size="3"
        aria-label={t("previousMonth")}
        onClick={() => step(-1)}
      >
        <ChevronLeft size={18} />
      </IconButton>
      <Text weight="bold">{label}</Text>
      <IconButton
        type="button"
        variant="ghost"
        color="gray"
        size="3"
        aria-label={t("nextMonth")}
        disabled={nextDisabled}
        onClick={() => step(1)}
      >
        <ChevronRight size={18} />
      </IconButton>
    </Flex>
  );
}
