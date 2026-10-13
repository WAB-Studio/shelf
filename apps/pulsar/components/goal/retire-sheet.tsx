"use client";

import { type ReactNode, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

import { retireCommitment } from "@/app/actions/plan";
import { Button, Row, Sheet, SheetActions, Text } from "@/components/ui";
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
};

/**
 * `CompromisoRetirar.dc.html` (RP-13): says what survives, never what is
 * lost — the weeks already governed and the days already done. "Desde
 * mañana" is measured, not guessed: `lib/day/cadence.ts`'s `asksOn` compares
 * the day asked about to `retired_at` with a strict `>`, so the day a
 * commitment is retired on still asks and only the next one does not
 * (`private/measure-retire.ts` proved it against a real `loadDay` call
 * before and after retiring one).
 */
export function RetireSheet({ open, onOpenChange, commitmentId, name, factDayCount }: RetireSheetProps) {
  const t = useTranslations();
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);

  const description =
    factDayCount > 0
      ? t("plan.retireSheet.descriptionWithDays", { days: factDayCount })
      : t("plan.retireSheet.descriptionNoDays");

  async function handleRetire() {
    if (pending) return;
    setPending(true);
    setError(null);

    const result = await retireCommitment({ commitmentId });
    setPending(false);
    if (result.ok) {
      onOpenChange(false);
      router.refresh();
    } else {
      setError(result.error);
    }
  }

  return (
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
        <Button block variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
          {t("plan.retireSheet.cancel")}
        </Button>
      </SheetActions>
    </Sheet>
  );
}

export type CommitmentRowProps = {
  commitmentId: string;
  name: string;
  retired: boolean;
  retiredLabel: string;
  factDayCount: number;
  trailing?: ReactNode;
  // A habit with no goal says its cadence under the name and its note under that.
  meta?: ReactNode;
  preview?: string | null;
};

/**
 * The goal screen's own commitment row: a retired one stays disabled — never
 * hidden, never tappable (RP-13) — an active one opens `RetireSheet`.
 */
export function CommitmentRow({ commitmentId, name, retired, retiredLabel, factDayCount, trailing, meta, preview }: CommitmentRowProps) {
  const [open, setOpen] = useState(false);

  if (retired) {
    return <Row name={name} meta={retiredLabel} trailing={trailing} disabled />;
  }

  return (
    <>
      <Row name={name} meta={meta} metaVariant="sentence" preview={preview} trailing={trailing} onClick={() => setOpen(true)} />
      <RetireSheet
        open={open}
        onOpenChange={setOpen}
        commitmentId={commitmentId}
        name={name}
        factDayCount={factDayCount}
      />
    </>
  );
}
