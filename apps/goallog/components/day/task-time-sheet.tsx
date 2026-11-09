"use client";

import { useState, useTransition } from "react";
import { Clock } from "lucide-react";
import { useTranslations } from "next-intl";

import { completeOneOff, recordTaskTime } from "@/app/actions/one-offs";
import { timeChipsAround } from "@/lib/day/time-chips";
import { formatQuantity } from "@/lib/units/time";
import { quantitySchema } from "@/lib/validation/fact";
import { useTimeWords } from "@/components/ui/figure";
import { Button, Chip, Field, Flex, IconButton, Sheet, Text } from "@/components/ui";
import { type MessageKey } from "@/i18n/translator";

export type TaskTimeProps = {
  oneOffId: string;
  name: string;
  // The task's estimate in minutes, offered back as the answer (RP-147).
  estimate: number;
  // The minutes already recorded on it; the answer offered instead of the estimate.
  spent: number | null;
  unit: string;
  // The past day the mark is dated (RP-129); absent, today.
  day?: string;
  onDone?: () => void;
};

/**
 * «llevas 1 h de 2 h» (RP-147): what a task estimated in time has recorded, or
 * undefined while nothing is.
 */
export function useSpentLine(spent: number | null | undefined, estimate: number | null, unit: string | null): string | undefined {
  const t = useTranslations();
  const words = useTimeWords();
  if (spent == null || estimate === null || unit === null) return undefined;
  return t("day.taskTimeSheet.spent", { spent: formatQuantity(spent, unit, words), estimate: formatQuantity(estimate, unit, words) });
}

/**
 * The clock beside a time task's mark and the sheet it opens (RP-147). The
 * sheet records the minutes without completing the task; only «Marcar hecha»
 * or the row's mark completes it.
 */
export function TaskTime({ oneOffId, name, estimate, spent, unit, day, onDone }: TaskTimeProps) {
  const t = useTranslations();
  const words = useTimeWords();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);
  const [selected, setSelected] = useState(spent ?? estimate);
  const [customMode, setCustomMode] = useState(false);
  const [customValue, setCustomValue] = useState("");

  const stored = spent ?? estimate;

  function handleOpenChange(next: boolean) {
    if (next) {
      setSelected(stored);
      setCustomMode(false);
      setCustomValue("");
      setError(null);
    }
    setOpen(next);
  }

  function customQuantity(): number | null {
    const trimmed = customValue.trim();
    if (trimmed.length === 0) return null;
    const parsed = quantitySchema.safeParse(Number(trimmed));
    return parsed.success ? parsed.data : null;
  }

  const quantity = customMode ? customQuantity() : selected;

  // Records the answer; «Marcar hecha» checks the task in the same act.
  function handleAccept(extendEstimate: boolean, complete: boolean) {
    if (pending) return;
    if (quantity == null) {
      setError("day.errors.quantityInvalid");
      return;
    }
    setError(null);

    startTransition(async () => {
      // Against what is recorded, not the chip it starts on: picking the estimate with nothing recorded records it.
      const changed = quantity !== spent || extendEstimate;
      // One act either way: the time and the check land together, or the check alone.
      const result = await (changed
        ? recordTaskTime({ oneOffId, minutes: quantity, extendEstimate: extendEstimate || undefined, complete: complete || undefined, day })
        : complete
          ? completeOneOff({ oneOffId, day })
          : Promise.resolve({ ok: true as const })
      ).catch(() => null);
      if (!result) return;
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOpen(false);
      onDone?.();
    });
  }

  return (
    <>
      <IconButton
        tap={44}
        variant="ghost"
        tone={spent !== null ? "accent" : undefined}
        aria-label={t("day.taskTimeSheet.open", { name })}
        onClick={() => handleOpenChange(true)}
      >
        <Clock size={18} aria-hidden />
      </IconButton>
      <Sheet open={open} onOpenChange={handleOpenChange} label={name} title={t("day.taskTimeSheet.question")}>
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

        <Button block onClick={() => handleAccept(false, false)} disabled={pending}>
          {t("day.quantitySheet.accept")}
        </Button>
        {quantity != null && quantity > estimate ? (
          <Button block variant="outline" onClick={() => handleAccept(true, false)} disabled={pending}>
            {t("day.taskTimeSheet.extend")}
          </Button>
        ) : null}
        <Button block variant="outline" onClick={() => handleAccept(false, true)} disabled={pending}>
          {t("day.taskTimeSheet.markDone")}
        </Button>
      </Sheet>
    </>
  );
}
