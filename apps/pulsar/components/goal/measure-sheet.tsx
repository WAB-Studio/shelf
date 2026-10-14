"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

import { setGoalMeasure } from "@/app/actions/plan";
import { setGoalMeasureSchema } from "@/lib/validation/measure";
import { Button, Field, Flex, Sheet, SheetActions } from "@/components/ui";
import { messageKey } from "@/i18n/translator";

type Refusal = { field: "name" | "unit"; text: string };

/**
 * `Ponerle medida` (RP-117): under «esta meta no mide nada», a sheet that asks what the goal
 * counts and in which unit. The same schema and the same act as the AI door; a refusal reads
 * under the field it touches.
 */
export function MeasureAction({ goalId, goalName }: { goalId: string; goalName: string }) {
  const t = useTranslations();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [unit, setUnit] = useState("");
  const [pending, setPending] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);

  function openSheet() {
    setName("");
    setUnit("");
    setRefusal(null);
    setOpen(true);
  }

  async function handleSave() {
    if (pending) return;

    const parsed = setGoalMeasureSchema.safeParse({ goalId, name, unit });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const field = issue.path[0] === "name" ? "name" : "unit";
      const key = messageKey(issue.message);
      setRefusal({ field, text: key === "plan.errors.nameEmpty" ? t("goal.measure.nameEmpty") : t(key) });
      return;
    }

    setPending(true);
    setRefusal(null);

    const result = await setGoalMeasure(parsed.data);
    setPending(false);
    if (result.ok) {
      setOpen(false);
      router.refresh();
    } else if (result.error === "plan.errors.measureKept") {
      setRefusal({ field: "unit", text: t("goal.measure.kept", { unit: result.values?.name ?? "" }) });
    } else {
      setRefusal({ field: "unit", text: t(result.error) });
    }
  }

  return (
    <>
      <Flex>
        <Button variant="ghost" tone="accent" tap={44} onClick={openSheet}>
          {t("goal.measure.offer")}
        </Button>
      </Flex>
      <Sheet open={open} onOpenChange={setOpen} label={goalName} title={t("goal.measure.title")}>
        <Field
          label={t("goal.measure.nameLabel")}
          placeholder={t("goal.measure.namePlaceholder")}
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            setRefusal(null);
          }}
          invalid={refusal?.field === "name"}
          hint={refusal?.field === "name" ? refusal.text : undefined}
          autoFocus
        />
        <Field
          label={t("goal.measure.unitLabel")}
          placeholder={t("goal.measure.unitPlaceholder")}
          value={unit}
          onChange={(event) => {
            setUnit(event.target.value);
            setRefusal(null);
          }}
          invalid={refusal?.field === "unit"}
          hint={refusal?.field === "unit" ? refusal.text : undefined}
        />
        <SheetActions>
          <Button block onClick={handleSave} disabled={pending}>
            {t("goal.measure.confirm")}
          </Button>
          <Button block variant="outline" onClick={() => setOpen(false)} disabled={pending}>
            {t("goal.measure.cancel")}
          </Button>
        </SheetActions>
      </Sheet>
    </>
  );
}
