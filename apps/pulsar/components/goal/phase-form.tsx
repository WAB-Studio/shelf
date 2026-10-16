"use client";

import { useRef, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { z } from "zod";

import { addPhase } from "@/app/actions/plan";
import { deletePhase, editPhase } from "@/app/actions/plan-edit";
import { editPhaseSchema } from "@/lib/validation/plan-edit";
import { addPhaseSchema, phasesOverlap, phaseWithinHorizon, type PhaseSpan } from "@/lib/validation/plan";
import {
  Button,
  Field,
  FieldPair,
  Figure,
  Page,
  ScreenHeader,
  Section,
  Sheet,
  SheetActions,
  Text,
  TextLink,
} from "@/components/ui";
import { dayBefore, horizonWeeksOf, weekIndexOf } from "@/lib/day/weeks";
import { civilDateLabel } from "@/lib/zone";

import { MAX_GOAL_WEEKS, weeksToPhaseSpan } from "./phase-weeks";
import { messageKey, type MessageKey } from "@/i18n/translator";

export type PhaseFormProps = {
  goalId: string;
  goalName: string;
  // The goal's own opening day, already read in the person's zone
  // (`civilDateInZone`) by the page: `weeksToPhaseSpan` is a pure function
  // over civil dates alone, never the browser's own zone.
  openedOn: string;
  // A goal names one horizon (RP-11); a phase past it is refused here first,
  // then again, authoritative, inside `addPhase`'s own transaction.
  // Null: the goal never ends, and no week is past it.
  horizon: string | null;
  defaultFromWeek: number | null;
  defaultToWeek: number | null;
  // Every phase the goal already has, spans alone: what the overlap refusal
  // checks against before the request ever reaches the server.
  existingPhases: (PhaseSpan & { name: string })[];
  // Present: the form edits this phase (RP-127), prefilled from it; absent, it adds one.
  phase?: { id: string; aim: string; startsOn: string; endsOn: string };
};

// A week number typed by hand, bounded well under any real horizon — the
// same ample, arbitrary ceiling `cadenceN` takes in `lib/validation/plan.ts`,
// so a mistyped digit reads as a message instead of reaching date arithmetic.
const weekSchema = z.coerce.number().int().positive().max(2_600);

const WEEKS_HINT = "phase-weeks-hint";

const AIM_ERRORS: MessageKey[] = ["plan.errors.aimEmpty", "plan.errors.aimTooLong"];
const WEEK_ERRORS: MessageKey[] = [
  "plan.errors.weekInvalid",
  "plan.errors.phaseBackwards",
  "plan.errors.startsOnInvalid",
  "plan.errors.endsOnInvalid",
];

/**
 * `/metas/[goalId]/fases/nueva`, `CompromisoNuevo.dc.html`'s own shape (RP-15,
 * docs/pulsar/DESIGN.md "A goal adds a commitment from its own screen" — the
 * same pattern, a phase): what it looks for, and which weeks — converted to
 * the civil dates `addPhaseSchema` and `addPhase` actually store with
 * `weeksToPhaseSpan`, the one convention `goal-screen.tsx`'s own
 * `phaseSpanLabel` already counts by. The overlap check runs here first, so
 * a span the server would refuse never leaves the device; `addPhase` runs it
 * again, authoritative, inside its own transaction.
 */
export function PhaseForm({
  goalId,
  goalName,
  openedOn,
  horizon,
  defaultFromWeek,
  defaultToWeek,
  existingPhases: allPhases,
  phase,
}: PhaseFormProps) {
  const t = useTranslations();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  // A phase never clashes with its own span.
  const existingPhases = phase
    ? allPhases.filter((other) => other.startsOn !== phase.startsOn || other.endsOn !== phase.endsOn)
    : allPhases;
  const [aim, setAim] = useState(phase?.aim ?? "");
  const [fromWeek, setFromWeek] = useState(
    phase ? String(weekIndexOf(openedOn, phase.startsOn)) : defaultFromWeek === null ? "" : String(defaultFromWeek),
  );
  const [toWeek, setToWeek] = useState(
    phase ? String(weekIndexOf(openedOn, phase.endsOn)) : defaultToWeek === null ? "" : String(defaultToWeek),
  );
  const [sheetOpen, setSheetOpen] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);
  const fromRef = useRef<HTMLInputElement>(null);
  const toRef = useRef<HTMLInputElement>(null);

  const fig = { fig: (chunks: ReactNode) => <Figure variant="meta" value={chunks} /> };
  const lastWeek = horizonWeeksOf(openedOn, horizon) ?? MAX_GOAL_WEEKS;
  const lastDay = horizon === null ? "" : civilDateLabel(dayBefore(horizon));
  const fromTyped = weekSchema.safeParse(fromWeek);
  const toTyped = weekSchema.safeParse(toWeek);
  const fromData = fromTyped.success ? fromTyped.data : null;
  const toData = toTyped.success ? toTyped.data : null;
  const ordered = fromData !== null && toData !== null && toData >= fromData;
  const noRoom = defaultFromWeek === null && !ordered;

  // The typed weeks read live: the days they cover, or the refusal naming the
  // goal's last week, or the phase they overlap. Derived, never stored.
  const span = ordered ? weeksToPhaseSpan(openedOn, fromData, toData, horizon) : null;
  const pastFrom = fromData !== null && fromData > lastWeek;
  const pastTo = toData !== null && toData > lastWeek;
  const beyond = ordered && (pastFrom || pastTo);
  const overlapped =
    span && !beyond
      ? [...existingPhases]
          .sort((a, b) => a.startsOn.localeCompare(b.startsOn))
          .find((phase) => phasesOverlap(span, phase))
      : undefined;
  const lastWeekFigures = { lastWeek, lastDay, ...fig };
  const liveLine: ReactNode = beyond || noRoom
    ? t.rich("plan.phaseForm.beyond", lastWeekFigures)
    : overlapped
      ? t.rich("plan.phaseForm.overlap", {
          from: weekIndexOf(openedOn, overlapped.startsOn),
          to: weekIndexOf(openedOn, overlapped.endsOn),
          aim: overlapped.name,
          next: weekIndexOf(openedOn, overlapped.endsOn) + 1,
          ...fig,
        })
      : span
        ? t.rich("plan.phaseForm.span", {
            from: civilDateLabel(span.startsOn),
            to: civilDateLabel(span.endsOn),
            ...lastWeekFigures,
          })
        : null;
  const showMoveEnd = beyond || noRoom;
  const livePast = beyond || overlapped !== undefined;

  // A refusal reads at the field it is about, with its ring. The two week
  // fields share one sentence under the pair: a half-width hint would break
  // it into four lines.
  const aimRefusal = error && AIM_ERRORS.includes(error) ? t(error) : undefined;
  const submitWeeksRefusal = error && WEEK_ERRORS.includes(error) ? t(error) : undefined;
  const otherRefusal = error && !aimRefusal && !submitWeeksRefusal ? t(error) : undefined;
  const fromInvalid = pastFrom || overlapped !== undefined || submitWeeksRefusal !== undefined;
  const toInvalid = (pastTo && !pastFrom) || submitWeeksRefusal !== undefined;

  function handleSubmit() {
    if (pending) return;
    setError(null);

    const fromResult = weekSchema.safeParse(fromWeek);
    const toResult = weekSchema.safeParse(toWeek);
    if (!fromResult.success || !toResult.success) {
      setError("plan.errors.weekInvalid");
      return;
    }
    if (toResult.data < fromResult.data) {
      setError("plan.errors.phaseBackwards");
      return;
    }

    const typedSpan = weeksToPhaseSpan(openedOn, fromResult.data, toResult.data, horizon);
    if (!phaseWithinHorizon(typedSpan, horizon) || overlapped) {
      // The refusal already reads in the hint; focus on the ringed field announces it.
      (fromInvalid || !toInvalid ? fromRef : toRef).current?.focus();
      return;
    }

    const parsed = phase
      ? editPhaseSchema.safeParse({ phaseId: phase.id, aim, ...typedSpan })
      : addPhaseSchema.safeParse({ goalId, aim, ...typedSpan });
    if (!parsed.success) {
      setError(messageKey(parsed.error.issues[0].message));
      return;
    }

    const data = parsed.data;
    startTransition(() => {
      void ("phaseId" in data ? editPhase(data) : addPhase(data)).then((result) => {
        if (result.ok) {
          router.push(`/metas/${goalId}`);
          router.refresh();
        } else {
          setError(result.error);
        }
      });
    });
  }

  // The sheet stays open once the delete resolves: the route leaves under it.
  function handleDelete() {
    if (pending || !phase) return;
    setError(null);
    startTransition(() => {
      void deletePhase({ phaseId: phase.id }).then((result) => {
        if (result.ok) {
          router.push(`/metas/${goalId}`);
          router.refresh();
        } else {
          setSheetOpen(false);
          setError(result.error);
        }
      });
    });
  }

  return (
    <Page>
      <ScreenHeader title={t(phase ? "goal.phases.editTitle" : "plan.phaseForm.title")} back={{ href: `/metas/${goalId}`, place: goalName }} />

      <Field
        label={t("plan.phaseForm.aimLabel")}
        value={aim}
        onChange={(event) => setAim(event.target.value)}
        invalid={aimRefusal !== undefined}
        hint={aimRefusal}
      />

      <Section as="div">
        <FieldPair>
          <Field
            label={t("plan.phaseForm.fromLabel")}
            type="number"
            inputMode="numeric"
            min={1}
            step={1}
            ref={fromRef}
            value={fromWeek}
            onChange={(event) => setFromWeek(event.target.value)}
            invalid={fromInvalid}
            aria-describedby={WEEKS_HINT}
          />
          <Field
            label={t("plan.phaseForm.toLabel")}
            type="number"
            inputMode="numeric"
            min={1}
            step={1}
            ref={toRef}
            value={toWeek}
            onChange={(event) => setToWeek(event.target.value)}
            invalid={toInvalid}
            aria-describedby={WEEKS_HINT}
          />
        </FieldPair>
        {submitWeeksRefusal || liveLine ? (
          <Text as="p" id={WEEKS_HINT} tone={submitWeeksRefusal || livePast ? "ink" : "muted"} variant="sentence">
            {submitWeeksRefusal ?? liveLine}
          </Text>
        ) : null}
        {showMoveEnd ? <TextLink href={`/metas/${goalId}`}>{t("plan.phaseForm.moveEnd")}</TextLink> : null}
      </Section>

      {otherRefusal ? (
        <Text as="p" tone="ink" variant="sentence">
          {otherRefusal}
        </Text>
      ) : null}

      <Button block onClick={handleSubmit} disabled={pending}>
        {t(phase ? "goal.phases.save" : "plan.phaseForm.submit")}
      </Button>

      {phase ? (
        <>
          <Button block variant="outline" onClick={() => setSheetOpen(true)} disabled={pending}>
            {t("goal.phases.delete")}
          </Button>
          <Sheet
            open={sheetOpen}
            onOpenChange={setSheetOpen}
            label={phase.aim}
            title={t("goal.phases.delete")}
            description={t("goal.phases.deleteBody")}
          >
            <SheetActions>
              <Button block onClick={handleDelete} disabled={pending}>
                {t("goal.phases.deleteConfirm")}
              </Button>
              <Button block variant="outline" onClick={() => setSheetOpen(false)} disabled={pending}>
                {t("goal.phases.keep")}
              </Button>
            </SheetActions>
          </Sheet>
        </>
      ) : null}
    </Page>
  );
}
