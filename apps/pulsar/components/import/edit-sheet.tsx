"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";

import { isTimeUnit, splitMinutes } from "@/lib/units/time";
import { setMonthBudgetSchema } from "@/lib/validation/budget";
import { createOneOffSchema } from "@/lib/validation/one-off";
import { addPhaseSchema, createGoalSchema } from "@/lib/validation/plan";
import { setRhythmSchema } from "@/lib/validation/rhythm";
import { Button, Chip, ChipRow, Field, FieldPair, Flex, Sheet, SheetActions, SectionLabel } from "@/components/ui";
import { messageKey } from "@/i18n/translator";

const WHOLE = /^\d+$/;

export type Editing = {
  path: string;
  // Which words the sheet takes: the part's class, or the rhythm's own.
  kind: "goal" | "phase" | "month" | "commitment" | "task" | "subtask" | "rhythm";
  // The goal the part belongs to, over the title.
  eyebrow: string;
  // `null` where the part has no name or no figure of its own.
  name: string | null;
  amount: number | null;
  unit: string;
  // The month a task sits in and the months its goal runs through.
  month: string | null;
  months: string[];
};

export type Change = { name?: string; amount?: number; month?: string };

const nameSchema = {
  goal: createGoalSchema.shape.name,
  commitment: createGoalSchema.shape.name,
  phase: addPhaseSchema.shape.aim,
  task: createOneOffSchema.shape.name,
  subtask: createOneOffSchema.shape.name,
} as const;

const amountSchema = {
  month: setMonthBudgetSchema.shape.amount,
  task: createOneOffSchema.shape.estimate.nonoptional(),
  subtask: createOneOffSchema.shape.estimate.nonoptional(),
  rhythm: setRhythmSchema.shape.amount,
} as const;

/**
 * The one sheet that changes a part of the draft (RP-89), over the draft in memory: it carries
 * only the fields the part has. A time takes hours and minutes as two whole fields, any other
 * unit one. The forms' own schemas judge what is typed, and nothing is written.
 */
export function EditSheet({
  editing,
  monthWord,
  onClose,
  onSave,
}: {
  editing: Editing;
  monthWord: (month: string) => string;
  onClose: () => void;
  onSave: (change: Change) => void;
}) {
  const t = useTranslations();
  const timed = isTimeUnit(editing.unit);
  const parts = splitMinutes(editing.amount ?? 0);
  const [name, setName] = useState(editing.name ?? "");
  const [hours, setHours] = useState(String(parts.h));
  const [minutes, setMinutes] = useState(String(parts.min));
  const [single, setSingle] = useState(String(editing.amount ?? 0));
  const [month, setMonth] = useState(editing.month);
  const [nameError, setNameError] = useState<string | null>(null);
  const [amountError, setAmountError] = useState<string | null>(null);

  function save() {
    const change: Change = {};
    let refused = false;
    if (editing.name !== null && editing.kind !== "month" && editing.kind !== "rhythm") {
      const parsed = nameSchema[editing.kind].safeParse(name);
      if (!parsed.success) {
        setNameError(t(messageKey(parsed.error.issues[0].message)));
        refused = true;
      } else {
        setNameError(null);
        if (parsed.data !== editing.name) change.name = parsed.data;
      }
    }
    if (editing.amount !== null && (editing.kind === "month" || editing.kind === "task" || editing.kind === "subtask" || editing.kind === "rhythm")) {
      let typed: number;
      if (timed) {
        const h = hours.trim() === "" ? "0" : hours.trim();
        const min = minutes.trim() === "" ? "0" : minutes.trim();
        typed = WHOLE.test(h) && WHOLE.test(min) && Number(min) <= 59 ? Number(h) * 60 + Number(min) : Number.NaN;
        if (WHOLE.test(min) && Number(min) > 59) {
          setAmountError(t("month.errors.minutesInvalid"));
          refused = true;
        }
      } else {
        typed = WHOLE.test(single.trim()) ? Number(single.trim()) : Number.NaN;
      }
      if (!refused || !timed) {
        const parsed = amountSchema[editing.kind].safeParse(typed);
        if (!parsed.success) {
          setAmountError(t(messageKey(parsed.error.issues[0].message)));
          refused = true;
        } else {
          setAmountError(null);
          if (typed !== editing.amount) change.amount = typed;
        }
      }
    }
    if (refused) return;
    if (month !== null && month !== editing.month) change.month = month;
    onSave(change);
  }

  const title =
    editing.kind === "rhythm"
      ? t("import.review.edit.rhythmTitle")
      : t(`import.review.edit.titleOf.${editing.kind === "goal" ? "big" : editing.kind}` as const);
  const hasAmount = editing.amount !== null;

  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      label={editing.eyebrow}
      title={title}
    >
      <Flex direction="column" gap="4">
        {editing.name !== null ? (
          <Field
            label={t("import.review.edit.name")}
            value={name}
            onChange={(event) => setName(event.target.value)}
            invalid={nameError !== null}
            hint={nameError}
            autoFocus
          />
        ) : null}
        {hasAmount && timed ? (
          <FieldPair>
            <Field
              label={t("import.review.edit.hours")}
              type="number"
              inputMode="numeric"
              min={0}
              step={1}
              value={hours}
              onChange={(event) => setHours(event.target.value)}
              invalid={amountError !== null}
              autoFocus={editing.name === null}
            />
            <Field
              label={t("import.review.edit.minutes")}
              type="number"
              inputMode="numeric"
              min={0}
              max={59}
              step={1}
              value={minutes}
              onChange={(event) => setMinutes(event.target.value)}
              invalid={amountError !== null}
              hint={amountError}
            />
          </FieldPair>
        ) : null}
        {hasAmount && !timed ? (
          <Field
            label={t("month.plan.amountLabel", { unit: editing.unit })}
            type="number"
            inputMode="numeric"
            min={0}
            step={1}
            value={single}
            onChange={(event) => setSingle(event.target.value)}
            invalid={amountError !== null}
            hint={amountError}
            autoFocus={editing.name === null}
          />
        ) : null}
        {month !== null ? (
          <Flex direction="column" gap="2">
            <SectionLabel>{t("import.review.edit.month")}</SectionLabel>
            <div role="radiogroup" aria-label={t("import.review.edit.month")}>
              <ChipRow>
                {editing.months.map((entry) => (
                  <Chip key={entry} radio selected={entry === month} onClick={() => setMonth(entry)}>
                    {monthWord(entry)}
                  </Chip>
                ))}
              </ChipRow>
            </div>
          </Flex>
        ) : null}
      </Flex>
      <SheetActions>
        <Button block onClick={save}>
          {t("import.review.edit.save")}
        </Button>
        <Button block variant="outline" onClick={onClose}>
          {t("import.review.edit.cancel")}
        </Button>
      </SheetActions>
    </Sheet>
  );
}
