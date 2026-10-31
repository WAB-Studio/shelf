"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

import { renameCommitment } from "@/app/actions/plan-edit";
import { Button, Field, Sheet, SheetActions } from "@/components/ui";
import { messageKey, type MessageKey } from "@/i18n/translator";
import { renameCommitmentSchema } from "@/lib/validation/plan-edit";

import { RetireSheet } from "./retire-sheet";

/**
 * What a commitment's own screen offers beside its cadence: its name, which changes whatever facts name it,
 * its retirement, and its delete while no fact names it (RP-127).
 */
export function CommitmentActions({
  commitmentId,
  goalId,
  name,
  factDayCount,
  evidenceDayCount,
}: {
  commitmentId: string;
  goalId: string;
  name: string;
  factDayCount: number;
  evidenceDayCount?: number;
}) {
  const t = useTranslations();
  const router = useRouter();
  const [renameOpen, setRenameOpen] = useState(false);
  const [retireOpen, setRetireOpen] = useState(false);
  const [value, setValue] = useState(name);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);

  async function handleSave() {
    if (pending) return;
    const input = { commitmentId, name: value };
    const parsed = renameCommitmentSchema.safeParse(input);
    if (!parsed.success) {
      setError(messageKey(parsed.error.issues[0].message));
      return;
    }
    setPending(true);
    setError(null);
    const result = await renameCommitment(input);
    setPending(false);
    if (result.ok) {
      setRenameOpen(false);
      router.refresh();
    } else {
      setError(result.error);
    }
  }

  return (
    <>
      <Button
        variant="quiet"
        onClick={() => {
          setValue(name);
          setError(null);
          setRenameOpen(true);
        }}
      >
        {t("goal.commitments.rename")}
      </Button>
      <Button variant="quiet" tone="danger" onClick={() => setRetireOpen(true)}>
        {t("goal.commitments.retireOrDelete")}
      </Button>
      <Sheet
        open={renameOpen}
        onOpenChange={(next) => {
          if (!pending) setRenameOpen(next);
        }}
        label={name}
        title={t("goal.commitments.renameTitle")}
      >
        <Field
          label={t("goal.commitments.nameLabel")}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          invalid={error !== null}
          hint={error ? t(error) : undefined}
          autoFocus
        />
        <SheetActions>
          <Button block onClick={handleSave} disabled={pending}>
            {pending ? t("goal.commitments.savingName") : t("goal.commitments.saveName")}
          </Button>
          <Button block variant="outline" onClick={() => setRenameOpen(false)} disabled={pending}>
            {t("goal.commitments.cancelName")}
          </Button>
        </SheetActions>
      </Sheet>
      <RetireSheet
        open={retireOpen}
        onOpenChange={setRetireOpen}
        commitmentId={commitmentId}
        name={name}
        factDayCount={factDayCount}
        evidenceDayCount={evidenceDayCount}
        goalId={goalId}
      />
    </>
  );
}
