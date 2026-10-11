"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

import { setRhythm } from "@/app/actions/roadmap";
import { Button, Chip, ChipRow, Field, SheetActions, Text } from "@/components/ui";
import { useTimeWords } from "@/components/ui/figure";
import { daysBetween } from "@/lib/day/weeks";
import { releasedPlan } from "@/lib/plan/first-rhythm";
import { fillPlan, type PlanInput } from "@/lib/plan/roadmap";
import { monthNameWithYear } from "@/lib/plan/month-name";
import { monthOf } from "@/lib/plan/months";
import { formatQuantity, isTimeUnit, parseTime } from "@/lib/units/time";
import { setRhythmSchema } from "@/lib/validation/rhythm";
import { civilDateLabel } from "@/lib/zone";
import { messageKey } from "@/i18n/translator";

// Minutes a month: the three offers a time measure shows.
const OFFERS = [480, 720, 1200];

/**
 * `RoadmapSinRitmo`'s field group (RP-50), shared by the first rhythm and by
 * `RhythmSheet`: the chips, the «otra» input, the live hint and the act. The
 * hint reads `fillPlan` on the chosen rhythm, the same function the server
 * fills with. A measure that is not time has no hour chips, only the input.
 */
export function RhythmForm({
  goalId,
  unit,
  plan,
  initial,
  releases = 0,
  sheet = false,
  onDone,
}: {
  goalId: string;
  unit: string;
  plan: PlanInput;
  // Minutes (or units) a month the form opens on.
  initial: number | null;
  // How many fixed tasks the first rhythm sends back to the plan.
  releases?: number;
  // The sheet's words and buttons instead of the first rhythm's.
  sheet?: boolean;
  onDone?: () => void;
}) {
  const t = useTranslations();
  const router = useRouter();
  const words = useTimeWords();
  const time = isTimeUnit(unit);
  const [amount, setAmount] = useState<number | null>(initial ?? (time ? OFFERS[1] : null));
  const [typed, setTyped] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function parseTyped(value: string): number | null {
    const text = value.trim();
    if (text === "") return null;
    if (time) return parseTime(/[a-z]/i.test(text) ? text : `${text} h`);
    return /^\d+$/.test(text) ? Number(text) : null;
  }

  function type(value: string) {
    setTyped(value);
    setError(null);
    setAmount(value.trim() === "" ? null : parseTyped(value));
  }

  const checked = setRhythmSchema.safeParse({ goalId, amount: amount ?? Number.NaN });
  // The first rhythm sends the fixed tasks back, so the end is read from what is left.
  const base = sheet ? plan : releasedPlan(plan).plan;
  const filled = checked.success ? fillPlan({ ...base, rhythm: amount }) : null;
  const end = filled?.end ?? null;
  // A task split across months sits in each of them: count it once.
  const hoursOf = new Map<string, number>();
  for (const item of filled ? [...filled.months.flatMap((month) => month.items), ...filled.unplaced] : []) {
    hoursOf.set(item.task.id, item.hours);
  }
  const total = [...hoursOf.values()].reduce((sum, hours) => sum + hours, 0);

  let hint: string | null = null;
  if (amount !== null && end !== null && filled) {
    const late = daysBetween(filled.lastDay, end);
    if (sheet) {
      hint =
        late > 0
          ? t("roadmap.ritmo.previewLate", {
              hours: formatQuantity(amount, unit, words),
              date: civilDateLabel(end),
              weeks: Math.ceil(late / 7),
            })
          : t("roadmap.ritmo.preview", {
              hours: formatQuantity(amount, unit, words),
              date: civilDateLabel(end),
            });
    } else {
      hint = t("roadmap.sinRitmo.preview", {
        hours: formatQuantity(amount, unit, words),
        total: formatQuantity(total, unit, words),
        month: monthNameWithYear(monthOf(end)),
      });
    }
  }

  async function handleSave() {
    if (pending) return;
    if (!checked.success) {
      setError(t(messageKey(checked.error.issues[0].message)));
      return;
    }
    setPending(true);
    setError(null);
    const result = await setRhythm(checked.data);
    setPending(false);
    if (result.ok) {
      onDone?.();
      router.refresh();
    } else {
      setError(t(result.error));
    }
  }

  return (
    <>
      {time ? (
        <>
          <Text as="span" variant="meta" tone="secondary">
            {t("roadmap.sinRitmo.hoursPerMonth")}
          </Text>
          <ChipRow>
            {OFFERS.map((offer) => (
              <Chip
                key={offer}
                radio
                mono
                selected={amount === offer}
                onClick={() => {
                  setAmount(offer);
                  setTyped("");
                  setError(null);
                }}
              >
                {formatQuantity(offer, unit, words)}
              </Chip>
            ))}
          </ChipRow>
        </>
      ) : null}
      <Field
        label={time ? t("roadmap.sinRitmo.other") : unit}
        hideLabel={time}
        placeholder={time ? t("roadmap.sinRitmo.other") : undefined}
        inputMode={time ? "text" : "numeric"}
        value={typed}
        onChange={(event) => type(event.target.value)}
        invalid={error !== null}
        hint={error ?? hint}
      />
      {!sheet && releases > 0 ? (
        <Text as="p" variant="sentence">
          {t("roadmap.sinRitmo.releases", { count: releases })}
        </Text>
      ) : null}
      <SheetActions>
        <Button block onClick={handleSave} disabled={pending}>
          {sheet ? t("roadmap.ritmo.save") : t("roadmap.sinRitmo.build")}
        </Button>
        {sheet ? (
          <Button block variant="outline" onClick={onDone} disabled={pending}>
            {t("roadmap.ritmo.cancel")}
          </Button>
        ) : null}
      </SheetActions>
    </>
  );
}
