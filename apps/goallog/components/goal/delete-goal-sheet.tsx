"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

import { deleteGoal } from "@/app/actions/goal-edit";
import { Button, Sheet, SheetActions, Text } from "@/components/ui";
import { type MessageKey } from "@/i18n/translator";

/**
 * `Borrar la meta` (RP-127): offered only to a goal no fact depends on and that holds no goal.
 * The sheet names what goes; the act refuses again if a fact or a goal arrived meanwhile, and
 * says why under the sentence. A deleted goal leaves the person on the goal above, or on Metas.
 */
export function DeleteGoalSheet({
  goalId,
  name,
  above = null,
  block = false,
}: {
  goalId: string;
  name: string;
  // The goal this one sits in; the screen lands there once it is gone.
  above?: string | null;
  block?: boolean;
}) {
  const t = useTranslations();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<MessageKey | null>(null);

  function openSheet() {
    setError(null);
    setOpen(true);
  }

  // The sheet stays open once the delete resolves: the route leaves under it.
  function handleDelete() {
    if (pending) return;
    setError(null);
    startTransition(() => {
      void deleteGoal({ goalId }).then((result) => {
        if (result.ok) {
          router.push(above === null ? "/metas" : `/metas/${above}`);
        } else {
          setError(result.error);
        }
      });
    });
  }

  return (
    <>
      <Button variant="outline" block={block} onClick={openSheet}>
        {t("goal.delete.action")}
      </Button>
      <Sheet
        open={open}
        onOpenChange={setOpen}
        label={name}
        title={t("goal.delete.action")}
        description={t("goal.delete.body", { goal: name })}
      >
        {error ? (
          <Text as="p" tone="muted" variant="sentence">
            {t(error)}
          </Text>
        ) : null}
        <SheetActions>
          <Button block onClick={handleDelete} disabled={pending}>
            {t("goal.delete.confirm")}
          </Button>
          <Button block variant="outline" onClick={() => setOpen(false)} disabled={pending}>
            {t("goal.delete.keep")}
          </Button>
        </SheetActions>
      </Sheet>
    </>
  );
}
