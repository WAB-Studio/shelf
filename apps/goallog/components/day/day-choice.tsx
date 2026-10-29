"use client";

import { type ReactNode, useId } from "react";
import { useTranslations } from "next-intl";

import { Chip, Field, Flex, Text } from "@/components/ui";

import type { DayChoiceKind, DayChoiceValue } from "./day-for-choice";
import type { MessageKey } from "@/i18n/translator";

export type DayChoiceProps = {
  value: DayChoiceValue;
  onChange: (value: DayChoiceValue) => void;
  // A one-off may wait with no day (RP-59); a caller that needs a day drops it.
  allowNone: boolean;
  // «hoy» is a destination unless the caller says it is not.
  allowToday?: boolean;
  // Earliest date the picker offers: the day already gone is never one.
  min: string;
  // Set when the schema refused the picked date; already a catalogue key.
  error?: MessageKey | null;
  // Sits under the chips and the date, indented with them («Anotar»).
  action?: ReactNode;
};

const KINDS: DayChoiceKind[] = ["today", "tomorrow", "other", "none"];

/**
 * «Para cuándo» (`HoySueltaDia.dc.html`): four chips and, for «otro día», a
 * date. Draws no state of its own; the caller holds the choice.
 */
export function DayChoice({ value, onChange, allowNone, allowToday = true, min, error, action }: DayChoiceProps) {
  const t = useTranslations();
  const errorId = useId();

  return (
    <Flex direction="column" gap="2" ml="38px">
      <Flex role="radiogroup" aria-label={t("day.choice.label")} gap="2" wrap="wrap">
        {KINDS.filter((kind) => (allowNone || kind !== "none") && (allowToday || kind !== "today")).map((kind) => (
          <Chip
            key={kind}
            shape="choice"
            radio
            selected={value.kind === kind}
            onClick={() => onChange({ ...value, kind })}
          >
            {t(`day.choice.${kind}`)}
          </Chip>
        ))}
      </Flex>
      {value.kind === "other" ? (
        <>
          <Field
            label={t("day.choice.dateLabel")}
            type="date"
            min={min}
            value={value.date}
            onChange={(event) => onChange({ ...value, date: event.target.value })}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
          />
          {error ? (
            <Text id={errorId} as="p" tone="ink" variant="name">
              {t(error)}
            </Text>
          ) : null}
        </>
      ) : null}
      {action}
    </Flex>
  );
}
