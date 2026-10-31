"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";

import { archiveGoal, reopenGoal } from "@/app/actions/plan";
import { Button, Sheet, SheetActions, Text } from "@/components/ui";
import { type MessageKey } from "@/i18n/translator";

export type ArchiveGoalActionProps = {
  goalId: string;
  name: string;
  variant?: "outline" | "ghost" | "quiet";
  block?: boolean;
  // «Archivar» beside another control; the foot of the phone face says the whole act.
  short?: boolean;
  // The open goals under this one, named in the sheet; they go with it (RP-83).
  branchCount?: number;
  branchNames?: string[];
};

/**
 * `Archivar esta meta` (RP-24): an outlined block at the foot of the goal
 * screen, opening the retire sheet's own shape — its sentence naming what
 * survives (the goal's facts, the weeks it governed, its commitments) and
 * that it leaves Hoy and Semana, reopenable from Metas. One UPDATE of
 * `archived_at` alone, the same shape `retireCommitment` already takes for a
 * commitment. Nothing is deleted.
 */
export function ArchiveGoalAction({
  goalId,
  name,
  variant = "outline",
  block = true,
  short = false,
  branchCount = 0,
  branchNames = [],
}: ArchiveGoalActionProps) {
  const t = useTranslations();
  const format = useFormatter();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);
  const withBranch = branchCount > 0;

  async function handleArchive() {
    if (pending) return;
    setPending(true);
    setError(null);

    const result = await archiveGoal({ goalId });
    setPending(false);
    if (result.ok) {
      setOpen(false);
      router.refresh();
    } else {
      setError(result.error);
    }
  }

  return (
    <>
      <Button variant={variant} block={block} onClick={() => setOpen(true)}>
        {t(short ? "goal.detail.archiveShort" : "goal.detail.archive")}
      </Button>
      <Sheet
        open={open}
        onOpenChange={setOpen}
        label={name}
        title={t(withBranch ? "tree.archive.title" : "plan.archiveSheet.title")}
        description={
          withBranch
            ? t("tree.archive.withInside", {
                count: branchCount,
                names: format.list(
                  branchNames.map((branch) => t("tree.archive.branchName", { name: branch })),
                  { type: "conjunction" },
                ),
              })
            : t("plan.archiveSheet.description")
        }
      >
        {error ? (
          <Text as="p" tone="muted" variant="sentence">
            {t(error)}
          </Text>
        ) : null}
        <SheetActions>
          <Button block onClick={handleArchive} disabled={pending}>
            {withBranch ? t("tree.archive.confirm", { count: branchCount }) : t("plan.archiveSheet.confirm")}
          </Button>
          <Button block variant="outline" onClick={() => setOpen(false)} disabled={pending}>
            {withBranch ? t("tree.archive.cancel") : t("plan.archiveSheet.cancel")}
          </Button>
        </SheetActions>
      </Sheet>
    </>
  );
}

/**
 * `Reabrir` (RP-24): a direct action, no sheet — reopening is the reversal a
 * person reaches for without a second thought, the same way undoing a tap
 * needs none (RP-05, `docs/goallog/DESIGN.md` "Decisions taken here").
 */
export function ReopenGoalButton({ goalId }: { goalId: string }) {
  const t = useTranslations();
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleReopen() {
    if (pending) return;
    setPending(true);
    setError(null);

    const result = await reopenGoal({ goalId });
    setPending(false);
    if (result.ok) router.refresh();
    else setError(t(result.error, { name: "values" in result ? (result.values?.name ?? "") : "" }));
  }

  return (
    <>
      <Button block onClick={handleReopen} disabled={pending}>
        {t("goal.detail.reopen")}
      </Button>
      {error ? (
        <Text as="p" tone="muted" variant="sentence">
          {error}
        </Text>
      ) : null}
    </>
  );
}
