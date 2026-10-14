"use client";

import { useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { z } from "zod";

import { moveHorizon } from "@/app/actions/plan";
import { dayBefore, horizonForWeeks, weekIndexOf } from "@/lib/day/weeks";
import { horizonWeeks } from "./phase-weeks";
import { horizonTreeRefusal, type PlacementRefusal } from "@/lib/goals/placement";
import { refusalKey } from "@/lib/goals/refusal-key";
import { buildTree, type TreeRow } from "@/lib/goals/tree";
import { horizonRefusal, moveHorizonSchema } from "@/lib/validation/horizon";
import { civilDayMonthYear, todayInZone } from "@/lib/zone";
import { Button, Field, Flex, Notice, Sheet, SheetActions, Text } from "@/components/ui";
import { messageKey, type MessageKey } from "@/i18n/translator";

// The new-goal rule (`new-goal-form.tsx`): a whole number of weeks, 1 to 520.
const weeksSchema = z.coerce.number().int().positive().max(520);

type GoalRef = { id: string; name: string; horizon: string | null };

export type MoveHorizonActionProps = {
  goalId: string;
  name: string;
  openedOn: string;
  // The stored horizon: the first day after the goal, which need not be a week's edge. Null: no end.
  horizon: string | null;
  weeks: number | null;
  phases: { name: string; endsOn: string | null }[];
  // An ended goal opens the sheet on the count that ends this Sunday.
  reopening?: boolean;
  // The goal above, and every goal under this one: the ends this one's cannot cross (RP-79).
  above?: GoalRef | null;
  below?: GoalRef[];
  // Called with the number of goals the move took along.
  onMoved?: (count: number) => void;
  // Called with the last day a goal that had no end was given.
  onPut?: (lastDay: string) => void;
};

// What a goal with no end opens the sheet on.
const DEFAULT_WEEKS = 12;

const row = (id: string, parentId: string | null, ref: { name: string; horizon: string | null }): TreeRow => ({
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
  onPut,
}: MoveHorizonActionProps) {
  const t = useTranslations();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const startWeeks = weeks ?? DEFAULT_WEEKS;
  const noEnd = storedHorizon === null;
  // A reopened goal is offered what a goal with no end is: put an end on it, or leave it without one.
  const putMode = noEnd || reopening;
  // Every end sheet counts its weeks from the current one; the goal screen counts from the opening.
  const anchor = todayInZone();
  const [value, setValue] = useState(String(startWeeks));
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
  const untouched = !noEnd && !reopening && typed.success && typed.data === startWeeks;

  const candidate = typed.success && !untouched ? horizonForWeeks(anchor, typed.data) : null;
  // The goals below that end after the typed end: «Mover también sus finales» takes them along.
  const later =
    candidate === null
      ? []
      : below.flatMap((g) => (g.horizon !== null && g.horizon > candidate ? [{ ...g, horizon: g.horizon }] : []));

  // The goal above, judged by the rule the server runs; the goals below are offered, not refused,
  // except one with no end, which a goal with an end cannot hold.
  function treeSentenceFor(next: string | null): string | null {
    const refusal: PlacementRefusal | null = horizonTreeRefusal(
      buildTree([
        ...(above ? [row("above", null, above)] : []),
        row("goal", above ? "above" : null, { name, horizon: storedHorizon }),
        ...below.filter((g) => g.horizon === null).map((g) => row(g.id, "goal", g)),
      ]),
      "goal",
      next,
    );
    const ref = refusal && ("above" in refusal ? refusal.above : "below" in refusal ? refusal.below : null);
    if (!refusal || !ref) return null;
    return t(refusalKey(refusal.code), { name: ref.name, date: ref.horizon ? civilDayMonthYear(dayBefore(ref.horizon)) : "" });
  }

  const treeSentence = typed.success && !untouched ? treeSentenceFor(horizonForWeeks(anchor, typed.data)) : null;

  // The phase the refusal names: the page's, or the server's when it judged a longer one.
  function refusalText(key: MessageKey, count: number, phase: { name: string; endsOn: string } | null = lastPhase): string {
    return t(key, {
      weeks: count,
      name: phase?.name ?? "",
      week: phase ? weekIndexOf(anchor, phase.endsOn) : 0,
      fromOpening: phase ? weekIndexOf(openedOn, phase.endsOn) : 0,
    });
  }

  function openSheet() {
    setValue(String(startWeeks));
    setError(null);
    setOpen(true);
  }

  async function handleRemove() {
    if (pending) return;
    const sentence = treeSentenceFor(null);
    if (sentence) {
      setError(sentence);
      return;
    }
    await commit(null);
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

    await commit(horizonForWeeks(anchor, typed.data), moveBranch);
  }

  async function commit(horizon: string | null, moveBranch = false) {
    const count = typed.success ? typed.data : 0;
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
      setError(refusalText(refusal, count));
      return;
    }
    if (horizon !== null && treeSentence) {
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
      if (noEnd && horizon !== null) onPut?.(dayBefore(horizon));
      router.refresh();
    } else if (result.error.startsWith("goal.errors.")) {
      const served = "values" in result && result.values?.date ? { name: result.values.name, endsOn: result.values.date } : null;
      setError(refusalText(result.error, count, served ?? lastPhase));
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

  // The weeks the goal's own screen will read: the stored end when untouched, else the one the count writes.
  const shownHorizon = typed.success ? (untouched && storedHorizon ? storedHorizon : horizonForWeeks(anchor, typed.data)) : null;
  const total = shownHorizon === null ? null : horizonWeeks(openedOn, shownHorizon);
  const endsOn =
    shownHorizon === null || total === null
      ? t("goal.errors.horizonWeeksInvalid")
      : t("goal.horizon.endsOnTotal", { date: civilDayMonthYear(dayBefore(shownHorizon)), total });
  // A refusal takes the hint; the total moves to the muted line.
  const refused = treeSentence !== null || error !== null;

  return (
    <>
      <Button variant="ghost" tone="accent" tap={44} onClick={openSheet}>
        {t(noEnd ? "goal.detail.putEnd" : "goal.detail.moveHorizon")}
      </Button>
      <Sheet open={open} onOpenChange={setOpen} label={name} title={t("goal.horizon.title")}>
        <Field
          label={t("goal.horizon.weeksFromThis")}
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
        <Text as="p" variant="sentence" tone="muted">
          {refused && total !== null
            ? t("goal.horizon.bothCountsTotal", { n: weekIndexOf(openedOn, anchor), total })
            : t("goal.horizon.bothCounts", { n: weekIndexOf(openedOn, anchor) })}
        </Text>
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
        {putMode ? null : (
          <Flex>
            <Button variant="ghost" tone="accent" tap={44} onClick={handleRemove} disabled={pending}>
              {t("goal.horizon.removeEnd")}
            </Button>
          </Flex>
        )}
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
            {t(putMode ? "goal.horizon.putConfirm" : "goal.horizon.confirm")}
          </Button>
          <Button block variant="outline" onClick={reopening ? handleRemove : () => setOpen(false)} disabled={pending}>
            {t(putMode ? "goal.horizon.keepNoEnd" : "goal.horizon.cancel")}
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
  const [put, setPut] = useState<string | null>(null);
  return (
    <>
      <Flex justify="between" align="center">
        {children}
        {props.reopening ? null : <MoveHorizonAction {...props} onMoved={setMoved} onPut={setPut} />}
      </Flex>
      {moved > 0 ? <Notice role="note">{t("goal.horizon.moved", { count: moved })}</Notice> : null}
      {put && props.horizon !== null ? (
        <Notice role="note">{t("goal.horizon.putDone", { name: props.name, date: civilDayMonthYear(put) })}</Notice>
      ) : null}
    </>
  );
}
