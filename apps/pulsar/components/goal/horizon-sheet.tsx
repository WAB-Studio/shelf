"use client";

import { useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { z } from "zod";

import { moveHorizon } from "@/app/actions/plan";
import { dayBefore, horizonForWeeks, weekIndexOf } from "@/lib/day/weeks";
import { horizonTreeRefusal, type PlacementRefusal } from "@/lib/goals/placement";
import { refusalKey } from "@/lib/goals/refusal-key";
import { buildTree, type TreeRow } from "@/lib/goals/tree";
import { horizonRefusal, moveHorizonSchema } from "@/lib/validation/horizon";
import { civilDateLabel, civilDayMonthYear, todayInZone } from "@/lib/zone";
import { Button, Field, Flex, Notice, Sheet, SheetActions } from "@/components/ui";
import { messageKey, type MessageKey } from "@/i18n/translator";

// The new-goal rule (`new-goal-form.tsx`): a whole number of weeks, 1 to 520.
const weeksSchema = z.coerce.number().int().positive().max(520);

type GoalRef = { id: string; name: string; horizon: string };

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
  // The goal above, and every goal under this one: the ends this one's cannot cross (RP-79).
  above?: GoalRef | null;
  below?: GoalRef[];
  // Called with the number of goals the move took along.
  onMoved?: (count: number) => void;
};

const row = (id: string, parentId: string | null, ref: { name: string; horizon: string }): TreeRow => ({
  id,
  parentId,
  position: 0,
  createdAt: "",
  name: ref.name,
  horizon: ref.horizon,
  archivedAt: null,
  measureUnit: null,
});

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
  above = null,
  below = [],
  onMoved,
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

  const candidate = typed.success && !untouched ? horizonForWeeks(openedOn, typed.data) : null;
  // The goals below that end after the typed end: «Mover también sus finales» takes them along.
  const later = candidate === null ? [] : below.filter((g) => g.horizon > candidate);

  // The goal above, judged by the rule the server runs; the goals below are offered, not refused.
  const treeRefusal: PlacementRefusal | null =
    typed.success && !untouched
      ? horizonTreeRefusal(
          buildTree([
            ...(above ? [row("above", null, above)] : []),
            row("goal", above ? "above" : null, { name, horizon: storedHorizon }),
          ]),
          "goal",
          horizonForWeeks(openedOn, typed.data),
        )
      : null;

  function treeText(key: MessageKey, ref: { name: string; horizon: string }): string {
    return t(key, { name: ref.name, date: civilDayMonthYear(dayBefore(ref.horizon)) });
  }

  const named = treeRefusal && ("above" in treeRefusal ? treeRefusal.above : "below" in treeRefusal ? treeRefusal.below : null);
  const treeSentence = treeRefusal && named ? treeText(refusalKey(treeRefusal.code), named) : null;

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

  async function handleMove(moveBranch = false) {
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
    const parsed = moveHorizonSchema.safeParse({ goalId, horizon, ...(moveBranch ? { moveBranch: true } : {}) });
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
    if (treeSentence) {
      setError(treeSentence);
      return;
    }

    setPending(true);
    setError(null);

    const result = await moveHorizon(parsed.data);
    setPending(false);
    if (result.ok) {
      setOpen(false);
      if (moveBranch) onMoved?.(later.length);
      router.refresh();
    } else if (result.error.startsWith("goal.errors.")) {
      setError(refusalText(result.error, typed.data));
    } else if ("values" in result && result.values) {
      setError(
        t(result.error, {
          name: result.values.name,
          date: result.values.date ? civilDayMonthYear(result.values.date) : "",
        }),
      );
    } else {
      setError(t(result.error));
    }
  }

  const endsOn = typed.success
    ? t("goal.horizon.endsOn", {
        date: civilDayMonthYear(dayBefore(untouched ? storedHorizon : horizonForWeeks(openedOn, typed.data))),
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
          onChange={(event) => {
            setValue(event.target.value);
            setError(null);
          }}
          invalid={error !== null || !typed.success || treeSentence !== null || later.length > 0}
          hint={treeSentence ?? error ?? endsOn}
          autoFocus
        />
        {later.length > 0 && candidate !== null ? (
          <Notice
            role="note"
            title={t("goal.horizon.laterTitle", { count: later.length })}
            rows={later.map((g) =>
              t("goal.horizon.laterRow", { name: g.name, date: civilDayMonthYear(dayBefore(g.horizon)) }),
            )}
            aside={t("goal.horizon.laterAside", { count: later.length, date: civilDayMonthYear(dayBefore(candidate)) })}
          />
        ) : null}
        <SheetActions>
          {later.length > 0 ? (
            <Button block onClick={() => handleMove(true)} disabled={pending || treeSentence !== null}>
              {t("goal.horizon.moveBranch")}
            </Button>
          ) : null}
          <Button
            block
            variant={later.length > 0 ? "ghost" : "solid"}
            onClick={() => handleMove()}
            disabled={pending || treeSentence !== null || later.length > 0}
          >
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

/**
 * The end line of a goal with its move action, and under it the notice a move that took
 * goals along leaves behind.
 */
export function MoveEndRow({ children, ...props }: MoveHorizonActionProps & { children: ReactNode }) {
  const t = useTranslations();
  const [moved, setMoved] = useState(0);
  return (
    <>
      <Flex justify="between" align="center">
        {children}
        {props.reopening ? null : <MoveHorizonAction {...props} onMoved={setMoved} />}
      </Flex>
      {moved > 0 ? <Notice role="note">{t("goal.horizon.moved", { count: moved })}</Notice> : null}
    </>
  );
}
