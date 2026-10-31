"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

import { changeGoalMeasure, removeGoalMeasure } from "@/app/actions/goal-edit";
import { setGoalMeasure } from "@/app/actions/plan";
import { storedMeasure } from "@/lib/units/time";
import { changeGoalMeasureSchema } from "@/lib/validation/goal-edit";
import { setGoalMeasureSchema } from "@/lib/validation/measure";
import { Button, Field, Flex, Sheet, SheetActions, Text } from "@/components/ui";
import { messageKey } from "@/i18n/translator";

type Refusal = { field: "name" | "unit"; text: string };

/**
 * `Ponerle medida` (RP-117) and `Cambiar la medida` (RP-134): under «esta meta no mide nada», a
 * sheet that asks what the goal counts and in which unit; on a goal that measures and that no
 * fact feeds (`fed` false), the same sheet opens on the measure, says what a new unit takes away
 * and ends in `Quitar la medida`, its sentence over it. A fed measure draws the act disabled with its reason. The same schemas and acts as the AI door; a refusal reads under
 * the field it touches.
 */
export function MeasureAction({
  goalId,
  goalName,
  current,
  fed = false,
  rhythm = false,
  months = 0,
  counting = [],
}: {
  goalId: string;
  goalName: string;
  // The measure being changed; absent when the goal measures nothing yet.
  current?: { name: string; unit: string };
  // A fact feeds the measure: it stays fixed and nothing is offered (RP-134).
  fed?: boolean;
  // A rhythm and this many month amounts go with the measure (RP-134).
  rhythm?: boolean;
  months?: number;
  // The live commitments counted toward the measure, each with its unit: another unit cuts them off.
  counting?: { name: string; unit: string }[];
}) {
  const t = useTranslations();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [unit, setUnit] = useState("");
  const [pending, setPending] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [removeRefusal, setRemoveRefusal] = useState<string | null>(null);

  function openSheet() {
    setName(current?.name ?? "");
    setUnit(current?.unit ?? "");
    setRefusal(null);
    setRemoveRefusal(null);
    setOpen(true);
  }

  async function handleSave() {
    if (pending) return;

    const parsed = (current ? changeGoalMeasureSchema : setGoalMeasureSchema).safeParse({ goalId, name, unit });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const field = issue.path[0] === "name" ? "name" : "unit";
      const key = messageKey(issue.message);
      setRefusal({ field, text: key === "plan.errors.nameEmpty" ? t("goal.measure.nameEmpty") : t(key) });
      return;
    }

    setPending(true);
    setRefusal(null);

    const result = current ? await changeGoalMeasure(parsed.data) : await setGoalMeasure(parsed.data);
    setPending(false);
    if (result.ok) {
      setOpen(false);
      router.refresh();
    } else if (result.error === "plan.errors.measureKept") {
      const kept = "values" in result ? (result.values as { name?: string } | undefined)?.name : undefined;
      setRefusal({ field: "unit", text: t("goal.measure.kept", { unit: kept ?? "" }) });
    } else {
      setRefusal({ field: "unit", text: t(result.error) });
    }
  }

  async function handleRemove() {
    if (pending) return;
    setPending(true);
    setRemoveRefusal(null);

    const result = await removeGoalMeasure({ goalId });
    setPending(false);
    if (result.ok) {
      setOpen(false);
      router.refresh();
    } else {
      setRemoveRefusal(t(result.error));
    }
  }

  // Another stored unit clears the rhythm and the amounts written in the old one.
  const unitChanges = current !== undefined && unit.trim() !== "" && storedMeasure(unit.trim(), null).unit !== current.unit;

  // Commitments in the old unit stop feeding the goal once the unit is another.
  const stopping =
    current !== undefined && unitChanges ? counting.filter((commitment) => commitment.unit === current.unit) : [];

  if (current && fed) {
    return (
      <>
        <Text as="p" variant="name" tone="muted">
          {t("goal.measure.change")}
        </Text>
        <Text as="p" id="measure-fed-reason" variant="sentence" tone="muted">
          {t("goal.measure.fedReason")}
        </Text>
      </>
    );
  }

  return (
    <>
      <Flex>
        <Button variant="quiet" onClick={openSheet}>
          {t(current ? "goal.measure.change" : "goal.measure.offer")}
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
        {unitChanges ? (
          <Text as="p" variant="sentence" tone="muted">
            {t("goal.measure.unitChangeBody")}
          </Text>
        ) : null}
        {stopping.length > 0 ? (
          <Text as="p" variant="sentence" tone="muted">
            {t("goal.measure.stops", {
              count: stopping.length,
              names: new Intl.ListFormat("es", { style: "long", type: "conjunction" }).format(
                stopping.map((commitment) => commitment.name),
              ),
            })}
          </Text>
        ) : null}
        <SheetActions>
          <Button block onClick={handleSave} disabled={pending}>
            {t("goal.measure.confirm")}
          </Button>
          <Button block variant="outline" onClick={() => setOpen(false)} disabled={pending}>
            {t("goal.measure.cancel")}
          </Button>
        </SheetActions>
        {current ? (
          <>
            <Text as="p" variant="sentence" tone="muted">
              {t("goal.measure.removeBody", { rhythm: rhythm ? "yes" : "no", months })}
            </Text>
            {removeRefusal ? (
              <Text as="p" variant="sentence" tone="muted">
                {removeRefusal}
              </Text>
            ) : null}
            <Flex justify="start">
              <Button variant="ghost" onClick={handleRemove} disabled={pending}>
                {t("goal.measure.remove")}
              </Button>
            </Flex>
          </>
        ) : null}
      </Sheet>
    </>
  );
}
