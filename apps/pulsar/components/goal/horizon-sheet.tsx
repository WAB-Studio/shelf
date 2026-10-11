"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { z } from "zod";

import { moveHorizon } from "@/app/actions/plan";
import { dayBefore, horizonForWeeks, weekIndexOf } from "@/lib/day/weeks";
import { horizonRefusal, moveHorizonSchema } from "@/lib/validation/horizon";
import { civilDateLabel, todayInZone } from "@/lib/zone";
import { Button, Field, Sheet, SheetActions } from "@/components/ui";
import { messageKey, type MessageKey } from "@/i18n/translator";

// The new-goal rule (`new-goal-form.tsx`): a whole number of weeks, 1 to 520.
const weeksSchema = z.coerce.number().int().positive().max(520);

export type MoveHorizonActionProps = {
  goalId: string;
  name: string;
  openedOn: string;
  // The stored horizon: the first day after the goal, which need not be a week's edge.
  horizon: string;
  weeks: number;
  phases: { name: string; endsOn: string | null }[];
  // An ended goal opens the sheet on the count that ends this Sunday.
  reopening?: boolean;
};

/**
 * `mover el final` (RP-11, RP-25): a link at the goal's horizon line opening
 * a sheet with one weeks field. The count becomes the civil date
 * `horizonForWeeks` names, and the refusal the server would give runs here
 * first, on the phases the page loaded — same function, same message.
 */
export function MoveHorizonAction({
  goalId,
  name,
  openedOn,
  horizon: storedHorizon,
  weeks,
  phases,
  reopening = false,
}: MoveHorizonActionProps) {
  const t = useTranslations();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(String(weeks));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const lastPhase = phases.reduce<{ name: string; endsOn: string } | null>(
    (last, phase) =>
      phase.endsOn && (!last || phase.endsOn > last.endsOn)
        ? { name: phase.name, endsOn: phase.endsOn }
        : last,
    null,
  );

  const typed = weeksSchema.safeParse(value);
  // The opening count stands for the stored horizon itself, never for the
  // week's edge that count would write.
  const untouched = !reopening && typed.success && typed.data === weeks;

  function refusalText(key: MessageKey, count: number): string {
    return t(key, {
      weeks: count,
      name: lastPhase?.name ?? "",
      week: lastPhase ? weekIndexOf(openedOn, lastPhase.endsOn) : 0,
    });
  }

  function openSheet() {
    setValue(String(weeks));
    setError(null);
    setOpen(true);
  }

  async function handleMove() {
    if (pending) return;

    if (!typed.success) {
      setError(t("goal.errors.horizonWeeksInvalid"));
      return;
    }

    if (untouched) {
      setOpen(false);
      return;
    }

    const horizon = horizonForWeeks(openedOn, typed.data);
    const parsed = moveHorizonSchema.safeParse({ goalId, horizon });
    if (!parsed.success) {
      setError(t(messageKey(parsed.error.issues[0].message)));
      return;
    }

    const refusal = horizonRefusal({
      horizon,
      today: todayInZone(),
      lastPhaseEndsOn: lastPhase?.endsOn ?? null,
    });
    if (refusal) {
      setError(refusalText(refusal, typed.data));
      return;
    }

    setPending(true);
    setError(null);

    const result = await moveHorizon(parsed.data);
    setPending(false);
    if (result.ok) {
      setOpen(false);
      router.refresh();
    } else if (result.error.startsWith("goal.errors.")) {
      setError(refusalText(result.error, typed.data));
    } else {
      setError(t(result.error));
    }
  }

  const endsOn = typed.success
    ? t("goal.horizon.endsOn", {
        date: civilDateLabel(
          dayBefore(untouched ? storedHorizon : horizonForWeeks(openedOn, typed.data)),
          true,
        ),
      })
    : t("goal.errors.horizonWeeksInvalid");

  return (
    <>
      <Button variant="ghost" tone="accent" tap={44} onClick={openSheet}>
        {t("goal.detail.moveHorizon")}
      </Button>
      <Sheet open={open} onOpenChange={setOpen} label={name} title={t("goal.horizon.title")}>
        <Field
          label={t("goal.horizon.weeksLabel", { date: civilDateLabel(openedOn) })}
          type="number"
          inputMode="numeric"
          min={1}
          max={520}
          step={1}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          invalid={error !== null || !typed.success}
          hint={error ?? endsOn}
          autoFocus
        />
        <SheetActions>
          <Button block onClick={handleMove} disabled={pending}>
            {t("goal.horizon.confirm")}
          </Button>
          <Button block variant="outline" onClick={() => setOpen(false)} disabled={pending}>
            {t("goal.horizon.cancel")}
          </Button>
        </SheetActions>
      </Sheet>
    </>
  );
}
