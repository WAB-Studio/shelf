"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";

import { completeOneOff } from "@/app/actions/one-offs";
import { timeChipsAround } from "@/lib/day/time-chips";
import { formatQuantity } from "@/lib/units/time";
import { quantitySchema } from "@/lib/validation/fact";
import { useTimeWords } from "@/components/ui/figure";
import { Button, Chip, Field, Flex, Sheet, Text } from "@/components/ui";
import { type MessageKey } from "@/i18n/translator";

export type TaskTimeSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  oneOffId: string;
  name: string;
  // The task's estimate in minutes, offered back as the answer (RP-147).
  estimate: number;
  unit: string;
  // The past day the mark is dated (RP-129); absent, today.
  day?: string;
  onDone?: () => void;
};

/**
 * Asks how long a task estimated in time took (RP-147). Closing it completes
 * nothing; a time over the estimate also offers to make that time the estimate.
 */
export function TaskTimeSheet({ open, onOpenChange, oneOffId, name, estimate, unit, day, onDone }: TaskTimeSheetProps) {
  const t = useTranslations();
  const words = useTimeWords();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<MessageKey | null>(null);
  const [selected, setSelected] = useState(estimate);
  const [customMode, setCustomMode] = useState(false);
  const [customValue, setCustomValue] = useState("");
  const [wasOpen, setWasOpen] = useState(open);

  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setSelected(estimate);
      setCustomMode(false);
      setCustomValue("");
      setError(null);
    }
  }

  function customQuantity(): number | null {
    const trimmed = customValue.trim();
    if (trimmed.length === 0) return null;
    const parsed = quantitySchema.safeParse(Number(trimmed));
    return parsed.success ? parsed.data : null;
  }

  const quantity = customMode ? customQuantity() : selected;

  function handleAccept(extendEstimate: boolean) {
    if (pending) return;
    if (quantity == null) {
      setError("day.errors.quantityInvalid");
      return;
    }
    setError(null);

    startTransition(async () => {
      const result = await completeOneOff({
        oneOffId,
        day,
        quantity,
        extendEstimate: extendEstimate || undefined,
      }).catch(() => null);
      if (!result) return;
      if (result.ok) {
        onOpenChange(false);
        onDone?.();
      } else setError(result.error);
    });
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange} label={name} title={t("day.taskTimeSheet.question")}>
      <Flex gap="2" wrap="wrap" align="center">
        {timeChipsAround(estimate).map((value) => (
          <Chip
            key={value}
            mono
            selected={!customMode && selected === value}
            onClick={() => {
              setCustomMode(false);
              setSelected(value);
            }}
          >
            {formatQuantity(value, unit, words)}
          </Chip>
        ))}
      </Flex>

      {customMode ? (
        <Field
          label={t("day.quantitySheet.customLabelMinutes")}
          type="number"
          inputMode="numeric"
          min={1}
          step={1}
          value={customValue}
          onChange={(event) => setCustomValue(event.target.value)}
          autoFocus
        />
      ) : (
        <Button variant="ghost" onClick={() => setCustomMode(true)}>
          {t("day.quantitySheet.otherAmount")}
        </Button>
      )}

      {error ? (
        <Text as="p" variant="sentence">
          {t(error)}
        </Text>
      ) : null}

      <Button block onClick={() => handleAccept(false)} disabled={pending}>
        {t("day.quantitySheet.accept")}
      </Button>
      {quantity != null && quantity > estimate ? (
        <Button block variant="outline" onClick={() => handleAccept(true)} disabled={pending}>
          {t("day.taskTimeSheet.extend")}
        </Button>
      ) : null}
    </Sheet>
  );
}
