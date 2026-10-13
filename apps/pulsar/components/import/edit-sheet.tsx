"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";

import { z } from "zod";

import { dayBefore, horizonForWeeks, horizonWeeksOf } from "@/lib/day/weeks";
import { commitmentFormIssue, type DraftGoal } from "@/lib/import/draft";
import type { Cadence } from "@/lib/import/review";
import { isTimeUnit, splitMinutes } from "@/lib/units/time";
import { civilDateLabel } from "@/lib/zone";
import { setMonthBudgetSchema } from "@/lib/validation/budget";
import { createOneOffSchema } from "@/lib/validation/one-off";
import { addPhaseSchema, createGoalSchema } from "@/lib/validation/plan";
import { setRhythmSchema } from "@/lib/validation/rhythm";
import { Button, Chip, ChipRow, Field, FieldPair, Flex, Sheet, SheetActions, SectionLabel, Text } from "@/components/ui";
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
  // A commitment's cadence and what it counts, to change.
  commitment: { cadence: Cadence; entry: DraftGoal["commitments"][number]; read: string; saidDay: { word: string; day: string } | null } | null;
  // A goal's end, to change in whole weeks from `today`; `refuse` is the review's rule for an end.
  horizon: { current: string | null; today: string; refuse: (horizon: string | null) => { key: string; values: Record<string, string> } | null } | null;
};

export type Change = { name?: string; amount?: number; month?: string; horizon?: string | null; cadence?: Cadence };

const CADENCE_KINDS = ["daily", "weekdays", "times_per_week", "every_n_days", "times_per_month"] as const;
const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7];
const DEFAULT_WEEKS = 52;
const weeksSchema = z.coerce.number().int().positive().max(520);

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
  const horizon = editing.horizon;
  const weeksNow = horizon?.current ? horizonWeeksOf(horizon.today, horizon.current) : 0;
  // Whether the goal ends: «ponerle final» opens the weeks field, «Quitar el final» closes it.
  const [ends, setEnds] = useState(horizon?.current != null);
  const [weeks, setWeeks] = useState(String(weeksNow > 0 ? weeksNow : DEFAULT_WEEKS));
  const [kind, setKind] = useState<Cadence["kind"]>(editing.commitment?.cadence.kind ?? "daily");
  const [days, setDays] = useState<number[]>(editing.commitment?.cadence.weekdays ?? []);
  const [count, setCount] = useState(String(editing.commitment?.cadence.n ?? ""));
  const [cadenceError, setCadenceError] = useState<string | null>(null);
  const weekdayShort = t.raw("day.cadence.weekdayShort") as string[];

  // The end the weeks field stands for: untouched, the end the draft holds.
  const typedWeeks = weeksSchema.safeParse(weeks);
  const candidate = !horizon || !ends || !typedWeeks.success ? null : typedWeeks.data === weeksNow && horizon.current ? horizon.current : horizonForWeeks(horizon.today, typedWeeks.data);
  // Taking the end away is judged too: a goal under one with an end cannot go without.
  const dropped = horizon !== null && !ends && horizon.current !== null;
  const horizonRefusal = horizon && (candidate || dropped) ? horizon.refuse(candidate) : null;
  const horizonSentence = horizonRefusal
    ? t(messageKey(horizonRefusal.key), { name: horizonRefusal.values.name ?? "", date: horizonRefusal.values.date ? civilDateLabel(horizonRefusal.values.date) : "" })
    : null;

  function toggleDay(day: number) {
    setDays((now) => (now.includes(day) ? now.filter((value) => value !== day) : [...now, day].sort((a, b) => a - b)));
  }

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
    if (editing.amount !== null && (editing.kind === "month" || editing.kind === "task" || editing.kind === "subtask" || editing.kind === "rhythm" || editing.kind === "commitment")) {
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
        // A commitment's quantity is judged with its cadence below, by the form's own schema.
        const parsed = editing.kind === "commitment" ? ({ success: true } as const) : amountSchema[editing.kind].safeParse(typed);
        if (!parsed.success) {
          setAmountError(t(messageKey(parsed.error.issues[0].message)));
          refused = true;
        } else {
          setAmountError(null);
          if (typed !== editing.amount) change.amount = typed;
        }
      }
    }
    if (editing.commitment) {
      const cadence: Cadence = { kind, weekdays: days, n: kind === "daily" || kind === "weekdays" ? null : Number(count) };
      const entry = {
        ...editing.commitment.entry,
        name: change.name ?? editing.commitment.entry.name,
        cadenceKind: kind,
        cadenceWeekdays: kind === "weekdays" ? days : null,
        cadenceN: cadence.n,
        targetQuantity: change.amount ?? editing.commitment.entry.targetQuantity,
      };
      const issue = Number.isNaN(Number(count)) && cadence.n !== null ? "plan.errors.timesPerWeekInvalid" : commitmentFormIssue(entry);
      if (issue === "plan.errors.targetQuantityInvalid") {
        setAmountError(t(messageKey(issue)));
        refused = true;
      } else if (issue) {
        setCadenceError(t(messageKey(issue)));
        refused = true;
      } else {
        setCadenceError(null);
        const was = editing.commitment.cadence;
        if (kind !== was.kind || cadence.n !== was.n || days.join() !== was.weekdays.join()) change.cadence = cadence;
      }
    }
    if (horizon && !ends) {
      if (horizonSentence !== null) refused = true;
      else if (dropped) change.horizon = null;
    } else if (horizon) {
      if (!typedWeeks.success) {
        setAmountError(t("goal.errors.horizonWeeksInvalid"));
        refused = true;
      } else if (horizonSentence !== null) refused = true;
      else if (candidate !== null && candidate !== horizon.current) change.horizon = candidate;
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
        {editing.commitment ? (
          <Flex direction="column" gap="2">
            <SectionLabel>{t("import.review.edit.when")}</SectionLabel>
            <div role="radiogroup" aria-label={t("import.review.edit.when")}>
              <ChipRow>
                {CADENCE_KINDS.map((entry) => (
                  <Chip key={entry} radio selected={kind === entry} onClick={() => setKind(entry)}>
                    {t(`plan.commitmentForm.cadence.${entry}`)}
                  </Chip>
                ))}
              </ChipRow>
            </div>
            {kind === "weekdays" ? (
              <ChipRow tight>
                {WEEKDAYS.map((day) => (
                  <Chip key={day} shape="day" mono selected={days.includes(day)} onClick={() => toggleDay(day)}>
                    {weekdayShort[day - 1]}
                  </Chip>
                ))}
              </ChipRow>
            ) : null}
            {kind === "times_per_week" || kind === "every_n_days" || kind === "times_per_month" ? (
              <Field
                label={t(kind === "times_per_week" ? "plan.commitmentForm.timesPerWeekLabel" : kind === "every_n_days" ? "plan.commitmentForm.everyNDaysLabel" : "plan.commitmentForm.timesPerMonthLabel")}
                type="number"
                inputMode="numeric"
                min={1}
                step={1}
                value={count}
                onChange={(event) => setCount(event.target.value)}
                invalid={cadenceError !== null}
              />
            ) : null}
            {cadenceError ? (
              <Text as="p" tone="ink" variant="sentence">
                {cadenceError}
              </Text>
            ) : null}
            {editing.commitment.saidDay && kind !== "weekdays" ? (
              <Text as="p" variant="sentence" tone="muted">
                {t("import.review.edit.saidDay", { word: editing.commitment.saidDay.word, read: editing.commitment.read, day: editing.commitment.saidDay.day })}
              </Text>
            ) : null}
            {hasAmount ? <SectionLabel>{t("import.review.edit.eachTime")}</SectionLabel> : null}
          </Flex>
        ) : null}
        {horizon && !ends ? (
          <Flex align="center" justify="between" gap="3">
            <Text as="p" variant="sentence" tone="muted">
              {t("import.review.edit.noEnd")}
            </Text>
            <Button variant="ghost" tone="accent" onClick={() => setEnds(true)}>
              {t("import.review.edit.putEnd")}
            </Button>
          </Flex>
        ) : null}
        {horizon && !ends && horizonSentence ? (
          <Text as="p" variant="sentence" tone="ink">
            {horizonSentence}
          </Text>
        ) : null}
        {horizon && ends ? (
          <Field
            label={t("goal.horizon.weeksLabel", { date: civilDateLabel(horizon.today) })}
            type="number"
            inputMode="numeric"
            min={1}
            max={520}
            step={1}
            value={weeks}
            onChange={(event) => setWeeks(event.target.value)}
            invalid={horizonSentence !== null || amountError !== null || !typedWeeks.success}
            hint={horizonSentence ?? amountError ?? (candidate ? t("goal.horizon.endsOn", { date: civilDateLabel(dayBefore(candidate), true) }) : t("goal.errors.horizonWeeksInvalid"))}
            autoFocus={editing.name === null}
          />
        ) : null}
        {horizon && ends && horizon.current !== null ? (
          <Button variant="ghost" tone="accent" onClick={() => setEnds(false)}>
            {t("import.review.edit.dropEnd")}
          </Button>
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
        <Button block onClick={save} disabled={horizonSentence !== null}>
          {t("import.review.edit.save")}
        </Button>
        <Button block variant="outline" onClick={onClose}>
          {t("import.review.edit.cancel")}
        </Button>
      </SheetActions>
    </Sheet>
  );
}
