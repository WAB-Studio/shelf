"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

import { deleteOneOff } from "@/app/actions/one-offs";
import { Button, Sheet, SheetActions, Text } from "@/components/ui";
import { type MessageKey } from "@/i18n/translator";

export type OneOffDeleteSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  oneOffId: string;
  name: string;
};

/**
 * `SueltaBorrar.dc.html` (RP-22): the retire sheet's own shape — `Sheet` with
 * a solid confirm over an outlined way out — built as a sibling here rather
 * than by extracting `RetireSheet` (`components/goal/retire-sheet.tsx`),
 * which hardwires `retireCommitment` and reads `plan.retireSheet.*`. The sentence says what the act is not — done
 * leaves a record, deleted leaves nothing — so nobody reads a delete as an
 * undo.
 */
export function OneOffDeleteSheet({ open, onOpenChange, oneOffId, name }: OneOffDeleteSheetProps) {
  const t = useTranslations();
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);

  async function handleDelete() {
    if (pending) return;
    setPending(true);
    setError(null);

    const result = await deleteOneOff({ oneOffId });
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
      title={t("day.oneOffs.delete.title")}
      description={t("day.oneOffs.delete.description")}
    >
      {error ? (
        <Text as="p" variant="sentence">
          {t(error)}
        </Text>
      ) : null}
      <SheetActions>
        <Button block onClick={handleDelete} disabled={pending}>
          {t("day.oneOffs.delete.confirm")}
        </Button>
        <Button block variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
          {t("day.oneOffs.delete.cancel")}
        </Button>
      </SheetActions>
    </Sheet>
  );
}
