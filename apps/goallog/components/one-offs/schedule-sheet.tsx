"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";

import { scheduleOneOff } from "@/app/actions/one-offs";
import { DayChoice } from "@/components/day/day-choice";
import {
  DEFAULT_DAY_CHOICE,
  dayForChoice,
  type DayChoiceValue,
} from "@/components/day/day-for-choice";
import { Button, Sheet, SheetActions, Text } from "@/components/ui";
import { scheduleOneOffSchema } from "@/lib/validation/one-off";
import { todayInZone } from "@/lib/zone";
import { messageKey, type MessageKey } from "@/i18n/translator";

export type ScheduleSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  oneOffId: string;
  name: string;
  // Set for a one-off that already has a day: the sheet moves it instead of
  // giving it one (`SueltaMover.dc.html`).
  current?: { day: string; label: string };
};

/**
 * `SueltaDarDia.dc.html` (RP-59): «para cuándo» without «sin día» and the way
 * to give the one-off that day; deleting lives in its own sheet. With
 * `current` it is `SueltaMover.dc.html`: the day it has now, «Moverla».
 */
export function ScheduleSheet({
  open,
  onOpenChange,
  oneOffId,
  name,
  current,
}: ScheduleSheetProps) {
  const t = useTranslations();
  const [pending, startTransition] = useTransition();
  const [choice, setChoice] = useState<DayChoiceValue>(
    !current
      ? DEFAULT_DAY_CHOICE
      : current.day > todayInZone()
        ? { kind: "other", date: current.day }
        : current.day === todayInZone()
          ? { kind: "tomorrow", date: current.day }
          : { kind: "today", date: current.day },
  );
  const [error, setError] = useState<MessageKey | null>(null);

  function handleSchedule() {
    if (pending) return;

    // The schema the server runs, run first: a refused day never travels.
    const parsed = scheduleOneOffSchema.safeParse({
      oneOffId,
      day: dayForChoice(choice, todayInZone()),
    });
    if (!parsed.success) {
      setError(messageKey(parsed.error.issues[0].message));
      return;
    }
    setError(null);

    // Closed inside the transition so the close commits with the refreshed
    // list, never before it.
    startTransition(async () => {
      const result = await scheduleOneOff(parsed.data);
      if (result.ok) onOpenChange(false);
      else setError(result.error);
    });
  }

  const dateError = choice.kind === "other" && error?.startsWith("day.errors.oneOffDay") ? error : null;
  const otherError = dateError ? null : error;

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      label={name.toLocaleUpperCase("es")}
      title={t("oneOffs.schedule.title")}
      description={current ? t("oneOffs.schedule.now", { when: current.label }) : undefined}
    >
      <DayChoice
        value={choice}
        onChange={(next) => {
          setChoice(next);
          setError(null);
        }}
        allowNone={false}
        // A task of today has no «hoy» to move to; a carried one does, and
        // a later one (`/sueltas`) keeps it.
        allowToday={!current || current.day !== todayInZone()}
        min={todayInZone()}
        error={dateError}
      />
      {otherError ? (
        <Text as="p" tone="muted" variant="sentence">
          {t(otherError)}
        </Text>
      ) : null}
      <SheetActions>
        <Button block onClick={handleSchedule} disabled={pending}>
          {t(current ? "oneOffs.schedule.move" : "oneOffs.schedule.confirm")}
        </Button>
        <Button block variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
          {t(current ? "oneOffs.schedule.stay" : "oneOffs.schedule.keep")}
        </Button>
      </SheetActions>
    </Sheet>
  );
}
