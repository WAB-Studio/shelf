"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

import { retireCommitment } from "@/app/actions/plan";
import { deleteCommitment } from "@/app/actions/plan-edit";
import { Button, Flex, Sheet, SheetActions, Text } from "@/components/ui";
import { type MessageKey } from "@/i18n/translator";

export type RetireSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  commitmentId: string;
  name: string;
  // Distinct days already declared for this commitment (`lib/queries/
  // goal.ts`'s `factDayCount`): dropped from the sentence at zero rather
  // than say "0 días" (RP-13's own "what it leaves intact" is nothing to
  // name when nothing has been done yet).
  factDayCount: number;
  // Days its source met the threshold: days done, but never declared, so they never lock a deletion.
  evidenceDayCount?: number;
  // The goal the commitment belongs to. While no fact names it (RP-127) the sheet also offers its cadence page
  // and the delete; null is a loose habit, which offers both on its own screen instead.
  goalId: string | null;
};

export type DeleteSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  commitmentId: string;
  name: string;
  // A habit has no list to return to: deleted, it leaves its own screen for /metas.
  habit: boolean;
  // A goal's commitment: deleted, it leaves its own screen for the goal's.
  goalId?: string;
};

/**
 * The delete of a commitment or a loose habit no fact names (RP-127): a second sheet, because the first
 * sheet's «Retirarlo» is the act that keeps the row. A fact that landed while it was open comes back as
 * the act's own sentence and the row stays.
 */
export function DeleteCommitmentSheet({ open, onOpenChange, commitmentId, name, habit, goalId }: DeleteSheetProps) {
  const t = useTranslations();
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);

  async function handleDelete() {
    if (pending) return;
    setPending(true);
    setError(null);

    const result = await deleteCommitment({ commitmentId });
    if (result.ok) {
      onOpenChange(false);
      if (habit) router.push("/metas");
      else if (goalId) router.push(`/metas/${goalId}`);
      router.refresh();
    } else {
      setError(result.error);
    }
    setPending(false);
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!pending) onOpenChange(next);
      }}
      label={name}
      title={t(habit ? "habit.delete" : "goal.commitments.delete")}
      description={t(habit ? "habit.deleteBody" : "goal.commitments.deleteBody")}
    >
      {error ? (
        <Text as="p" tone="muted" variant="sentence">
          {t(error)}
        </Text>
      ) : null}
      <SheetActions>
        <Button block onClick={handleDelete} disabled={pending}>
          {t(habit ? "habit.deleteConfirm" : "goal.commitments.deleteConfirm")}
        </Button>
        <Button block variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
          {t(habit ? "habit.keep" : "plan.retireSheet.cancel")}
        </Button>
      </SheetActions>
    </Sheet>
  );
}

/**
 * `CompromisoRetirar.dc.html` (RP-13): says what survives, never what is
 * lost — the weeks already governed and the days already done. "Desde
 * mañana" is measured, not guessed: `lib/day/cadence.ts`'s `asksOn` compares
 * the day asked about to `retired_at` with a strict `>`, so the day a
 * commitment is retired on still asks and only the next one does not
 * (`private/measure-retire.ts` proved it against a real `loadDay` call
 * before and after retiring one).
 */
export function RetireSheet({ open, onOpenChange, commitmentId, name, factDayCount, evidenceDayCount = 0, goalId }: RetireSheetProps) {
  const t = useTranslations();
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  // The server refuses a delete by declared facts alone, and a cadence change by those and the source's days.
  const editable = factDayCount === 0 && goalId !== null;
  const cadenceOpen = editable && evidenceDayCount === 0;
  // Facts name it: the cadence and the delete stay in view, disabled, with their reason. A loose habit says it on its own screen.
  const locked = factDayCount > 0 && goalId !== null;
  const evidenceLocked = editable && evidenceDayCount > 0;
  const [error, setError] = useState<MessageKey | null>(null);

  const description = [
    factDayCount > 0
      ? t("plan.retireSheet.descriptionWithDays", { days: factDayCount })
      : t("plan.retireSheet.descriptionNoDays"),
    evidenceDayCount > 0 ? t("plan.retireSheet.evidenceDays", { days: evidenceDayCount }) : null,
  ]
    .filter(Boolean)
    .join(" ");

  async function handleRetire() {
    if (pending) return;
    setPending(true);
    setError(null);

    const result = await retireCommitment({ commitmentId });
    setPending(false);
    if (result.ok) {
      onOpenChange(false);
      // A goal's commitment is retired from its own screen, which then has nothing to show.
      if (goalId) router.push(`/metas/${goalId}`);
      router.refresh();
    } else {
      setError(result.error);
    }
  }

  return (
    <>
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      label={name}
      title={t("plan.retireSheet.title")}
      description={description}
    >
      {error ? (
        <Text as="p" tone="muted" variant="sentence">
          {t(error)}
        </Text>
      ) : null}
      <SheetActions>
        <Button block onClick={handleRetire} disabled={pending}>
          {t("plan.retireSheet.confirm")}
        </Button>
        {cadenceOpen ? (
          // The sheet opens on this commitment's own screen, where the link points: pressing it closes the sheet over it.
          <Button asChild block variant="outline">
            <Link href={`/metas/${goalId}/compromisos/${commitmentId}`} onClick={() => onOpenChange(false)}>
              {t("goal.commitments.changeCadence")}
            </Link>
          </Button>
        ) : locked || evidenceLocked ? (
          <Button block variant="outline" disabled aria-describedby="cadence-locked-reason">
            {t("goal.commitments.changeCadence")}
          </Button>
        ) : null}
        <Button block variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
          {t("plan.retireSheet.cancel")}
        </Button>
      </SheetActions>
      {editable ? (
        <Flex justify="start">
          <Button
            variant="ghost"
            onClick={() => {
              onOpenChange(false);
              setDeleteOpen(true);
            }}
            disabled={pending}
          >
            {t("goal.commitments.delete")}
          </Button>
        </Flex>
      ) : null}
      {evidenceLocked ? (
        <Text as="p" id="cadence-locked-reason" variant="sentence" tone="muted">
          {t("plan.retireSheet.evidenceLocked", { days: evidenceDayCount })}
        </Text>
      ) : null}
      {locked ? (
        <>
          <Flex justify="start">
            <Button variant="ghost" disabled aria-describedby="cadence-locked-reason">
              {t("goal.commitments.delete")}
            </Button>
          </Flex>
          <Text as="p" id="cadence-locked-reason" variant="sentence" tone="muted">
            {t("plan.errors.cadenceHasFacts")}
          </Text>
        </>
      ) : null}
    </Sheet>
    {editable ? (
      <DeleteCommitmentSheet
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        commitmentId={commitmentId}
        name={name}
        habit={false}
        goalId={goalId}
      />
    ) : null}
    </>
  );
}

/**
 * `HabitoPantalla` (RP-127): «Borrar el hábito», a muted act at the screen's foot for a habit no fact names.
 */
export function DeleteHabitAction({ label, ...sheet }: Omit<DeleteSheetProps, "open" | "onOpenChange" | "habit"> & { label: string }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Flex justify="start">
        <Button variant="ghost" onClick={() => setOpen(true)}>
          {label}
        </Button>
      </Flex>
      <DeleteCommitmentSheet open={open} onOpenChange={setOpen} habit {...sheet} />
    </>
  );
}

/**
 * `HabitoPantalla`: the habit screen's own «Retirarlo», a block button that
 * opens the same sheet the row once did. Done, the screen refreshes into its
 * retired state; it does not leave.
 */
export function RetireAction({ label, ...sheet }: Omit<RetireSheetProps, "open" | "onOpenChange" | "goalId"> & { label: string }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button block variant="outline" onClick={() => setOpen(true)}>
        {label}
      </Button>
      <RetireSheet open={open} onOpenChange={setOpen} goalId={null} {...sheet} />
    </>
  );
}
