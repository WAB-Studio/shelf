"use client";

import { useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

import Link from "next/link";

import { addCommitment } from "@/app/actions/plan";
import { editCadence } from "@/app/actions/plan-edit";
import type { Cadence } from "@/lib/day/types";
import { addCommitmentSchema, type AddCommitmentInput } from "@/lib/validation/plan";
import { editCadenceSchema } from "@/lib/validation/plan-edit";
import { Button, Chip, ChipRow, Field, FieldPair, Page, ScreenHeader, Section, Text, TextArea } from "@/components/ui";
import { messageKey, type MessageKey, type SourceKey } from "@/i18n/translator";

export type CommitmentFormProps = {
  // Null: a habit that belongs to no goal (RP-100), which carries a note and has no source.
  goalId: string | null;
  goalName: string;
  // Whether the goal already names a measure (§0.3, 3): only matters while
  // `satisfaction === "quantity"`, to say the unit typed here is the one
  // that sets it.
  hasMeasure: boolean;
  // The goal's own unit when it measures: the quantity takes it, no field.
  measureUnit: string | null;
  // The evidence catalogue (RP-07, RNP-10), read off `goals.evidence_sources`
  // by the page: a second source is a seeded row, never a case this form
  // hardcodes.
  sources: { key: string; labelKey: SourceKey; unit: string }[];
  // Cadence-only edit (RP-127): the form opens on the row's cadence, asks for nothing else and saves
  // through `editCadence`. `goalName` then names the place the way back and «Cancelar» return to.
  edit?: { commitmentId: string; cadence: Cadence; name?: string };
  // What the edit screen offers under its buttons: the commitment's name, retirement and delete.
  foot?: ReactNode;
};

// RP-12's five cadences (`lib/day/types.ts`'s `Cadence`), in the order of
// `CompromisoNuevoMes.dc.html`.
const CADENCE_KINDS = ["daily", "weekdays", "times_per_week", "every_n_days", "times_per_month"] as const;
type CadenceKind = (typeof CADENCE_KINDS)[number];

const SATISFACTION_KINDS = ["tap", "quantity", "evidence"] as const;
type SatisfactionKind = (typeof SATISFACTION_KINDS)[number];

const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7];

// Which control a refusal belongs to, by the message the schema carries: the
// ring and the sentence land there, never in a line far from it.
const NAME_ERRORS: MessageKey[] = ["plan.errors.nameEmpty", "plan.errors.nameTooLong"];
const WEEKDAY_ERRORS: MessageKey[] = ["plan.errors.weekdaysEmpty", "plan.errors.weekdayInvalid"];
const COUNT_ERRORS: MessageKey[] = [
  "plan.errors.timesPerWeekInvalid",
  "plan.errors.everyNDaysInvalid",
  "plan.errors.timesPerMonthInvalid",
];
const QUANTITY_ERRORS: MessageKey[] = ["plan.errors.targetQuantityInvalid"];
const UNIT_ERRORS: MessageKey[] = ["plan.errors.unitEmpty", "plan.errors.unitTooLong"];
const THRESHOLD_ERRORS: MessageKey[] = ["plan.errors.thresholdInvalid"];

/**
 * `CompromisoNuevo.dc.html` (RP-12): what it is, how often, what gives it for
 * done — and, for a habit with no goal (RP-100), a note. Drives `addCommitment` over its own Zod schema
 * (`lib/validation/plan.ts`), parsed here first so a bound the server would
 * refuse never leaves the device — the same shape `NewGoalForm` already
 * takes. No new server code.
 */
export function CommitmentForm({ goalId, goalName, hasMeasure, measureUnit, sources, edit, foot }: CommitmentFormProps) {
  const t = useTranslations();
  const router = useRouter();
  // Held until the answer: a transition would end before it, and a second tap would write a second row.
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);
  const habit = goalId === null;

  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const start = edit?.cadence;
  const [cadenceKind, setCadenceKind] = useState<CadenceKind>(start?.kind ?? "daily");
  const [weekdays, setWeekdays] = useState<number[]>(start?.kind === "weekdays" ? start.days : []);
  const [cadenceN, setCadenceN] = useState(
    start?.kind === "times_per_week" || start?.kind === "times_per_month"
      ? String(start.count)
      : start?.kind === "every_n_days"
        ? String(start.n)
        : "",
  );
  const [satisfaction, setSatisfaction] = useState<SatisfactionKind>("tap");
  const [targetQuantity, setTargetQuantity] = useState("");
  const [unit, setUnit] = useState("");
  const [sourceKey, setSourceKey] = useState(sources[0]?.key ?? "");
  const [threshold, setThreshold] = useState("1");

  const weekdayShort = t.raw("day.cadence.weekdayShort") as string[];
  const weekdayFull = t.raw("day.cadence.weekdayFull") as string[];

  // A source counted in time is not satisfied by one minute: offer half an hour until the person writes their own.
  function pickSource(source: CommitmentFormProps["sources"][number]) {
    setSourceKey(source.key);
    setThreshold((current) => (current === "1" || current === "30" ? (source.unit === "minutos" ? "30" : "1") : current));
  }

  function toggleWeekday(day: number) {
    setWeekdays((current) =>
      current.includes(day) ? current.filter((value) => value !== day) : [...current, day].sort(),
    );
  }

  // Where saving and «Cancelar» return: the screen the person came from.
  const returnTo = habit ? (edit ? `/metas/habitos/${edit.commitmentId}` : "/metas") : `/metas/${goalId}`;

  function buildCadence() {
    return cadenceKind === "daily"
        ? ({ cadenceKind: "daily" } as const)
        : cadenceKind === "weekdays"
          ? ({ cadenceKind: "weekdays", cadenceWeekdays: weekdays } as const)
          : cadenceKind === "times_per_week"
            ? ({ cadenceKind: "times_per_week", cadenceN: Number(cadenceN) } as const)
            : cadenceKind === "every_n_days"
              ? ({ cadenceKind: "every_n_days", cadenceN: Number(cadenceN) } as const)
              : ({ cadenceKind: "times_per_month", cadenceN: Number(cadenceN) } as const);
  }

  function handleEdit() {
    if (!edit) return;
    setError(null);
    const input = { commitmentId: edit.commitmentId, ...buildCadence() };
    const parsed = editCadenceSchema.safeParse(input);
    if (!parsed.success) {
      setError(messageKey(parsed.error.issues[0].message));
      return;
    }

    setPending(true);
    void editCadence(input).then((result) => {
      if (result.ok) {
        router.push(returnTo);
        router.refresh();
      } else {
        setPending(false);
        setError(result.error);
      }
    });
  }

  function buildInput(): AddCommitmentInput | null {
    const cadence = buildCadence();

    const done =
      satisfaction === "tap"
        ? ({ satisfaction: "tap" } as const)
        : satisfaction === "quantity"
          ? ({ satisfaction: "quantity", targetQuantity: Number(targetQuantity), unit: measureUnit ?? unit } as const)
          : ({ satisfaction: "evidence", sourceKey, threshold: Number(threshold) } as const);

    const parsed = addCommitmentSchema.safeParse({
      ...(goalId === null ? { note } : { goalId }),
      name,
      ...cadence,
      ...done,
    });
    if (!parsed.success) {
      setError(messageKey(parsed.error.issues[0].message));
      return null;
    }
    return parsed.data;
  }

  function handleSubmit() {
    if (pending) return;
    if (edit) return handleEdit();
    setError(null);

    const input = buildInput();
    if (!input) return;

    setPending(true);
    void addCommitment(input).then((result) => {
      if (result.ok) {
        router.push(returnTo);
        router.refresh();
      } else {
        setPending(false);
        setError(result.error);
      }
    });
  }

  const trimmedUnit = unit.trim();

  const refusal = (keys: MessageKey[]) => (error && keys.includes(error) ? t(error) : undefined);
  const nameRefusal = refusal(NAME_ERRORS);
  const weekdaysRefusal = refusal(WEEKDAY_ERRORS);
  const countRefusal = refusal(COUNT_ERRORS);
  const quantityRefusal = refusal(QUANTITY_ERRORS);
  const unitRefusal = refusal(UNIT_ERRORS);
  const thresholdRefusal = refusal(THRESHOLD_ERRORS);
  const ownedRefusal = [nameRefusal, weekdaysRefusal, countRefusal, quantityRefusal, unitRefusal, thresholdRefusal].some(Boolean);

  return (
    <Page>
      <ScreenHeader
        title={
          edit ? t("goal.commitments.cadenceTitle") : t(habit ? "plan.habitForm.title" : "plan.commitmentForm.title")
        }
        back={{ href: returnTo, place: goalName }}
        eyebrow={edit?.name}
      />

      {edit ? null : (
        <Field
          label={t("plan.commitmentForm.whatLabel")}
          value={name}
          onChange={(event) => setName(event.target.value)}
          invalid={nameRefusal !== undefined}
          hint={nameRefusal}
        />
      )}

      {habit && !edit ? (
        <TextArea
          label={t("plan.habitForm.noteLabel")}
          placeholder={t("plan.habitForm.notePlaceholder")}
          rows={3}
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
      ) : null}

      <Section label={t("plan.commitmentForm.whenLabel")}>
        <ChipRow radio label={t("plan.commitmentForm.whenLabel")}>
          {CADENCE_KINDS.map((kind) => (
            <Chip key={kind} radio selected={cadenceKind === kind} onClick={() => setCadenceKind(kind)}>
              {t(`plan.commitmentForm.cadence.${kind}`)}
            </Chip>
          ))}
        </ChipRow>

        {cadenceKind === "weekdays" ? (
          <ChipRow tight>
            {WEEKDAYS.map((day) => (
              <Chip
                key={day}
                shape="day"
                mono
                aria-label={weekdayFull[day - 1]}
                selected={weekdays.includes(day)}
                onClick={() => toggleWeekday(day)}
              >
                {weekdayShort[day - 1]}
              </Chip>
            ))}
          </ChipRow>
        ) : null}
        {weekdaysRefusal ? (
          <Text as="p" tone="ink" variant="sentence">
            {weekdaysRefusal}
          </Text>
        ) : null}

        {cadenceKind === "times_per_week" ? (
          <Field
            label={t("plan.commitmentForm.timesPerWeekLabel")}
            invalid={countRefusal !== undefined}
            hint={countRefusal}
            type="number"
            inputMode="numeric"
            min={1}
            step={1}
            value={cadenceN}
            onChange={(event) => setCadenceN(event.target.value)}
          />
        ) : null}

        {cadenceKind === "every_n_days" ? (
          <Field
            label={t("plan.commitmentForm.everyNDaysLabel")}
            invalid={countRefusal !== undefined}
            hint={countRefusal}
            type="number"
            inputMode="numeric"
            min={1}
            step={1}
            value={cadenceN}
            onChange={(event) => setCadenceN(event.target.value)}
          />
        ) : null}

        {cadenceKind === "times_per_month" ? (
          <Field
            label={t("plan.commitmentForm.timesPerMonthLabel")}
            invalid={countRefusal !== undefined}
            hint={countRefusal ?? t("plan.commitmentForm.timesPerMonthHint")}
            type="number"
            inputMode="numeric"
            min={1}
            max={31}
            step={1}
            value={cadenceN}
            onChange={(event) => setCadenceN(event.target.value)}
          />
        ) : null}
      </Section>

      {edit ? null : (
      <Section label={t("plan.commitmentForm.doneByLabel")}>
        <ChipRow>
          {SATISFACTION_KINDS.filter((kind) => kind !== "evidence" || sources.length > 0).map((kind) => (
            <Chip key={kind} selected={satisfaction === kind} onClick={() => setSatisfaction(kind)}>
              {t(`plan.commitmentForm.satisfaction.${kind}`)}
            </Chip>
          ))}
        </ChipRow>

        {satisfaction === "quantity" ? (
          <>
            <FieldPair narrow={88}>
              <Field
                label={t("plan.commitmentForm.quantityLabel")}
                type="number"
                inputMode="numeric"
                min={1}
                step={1}
                value={targetQuantity}
                onChange={(event) => setTargetQuantity(event.target.value)}
                invalid={quantityRefusal !== undefined}
              />
              {measureUnit !== null ? (
                <Text as="span" variant="sentence" tone="muted" data-testid="commitment-unit">
                  {measureUnit}
                </Text>
              ) : (
                <Field
                  label={t("plan.commitmentForm.unitLabel")}
                  value={unit}
                  onChange={(event) => setUnit(event.target.value)}
                  invalid={unitRefusal !== undefined}
                />
              )}
            </FieldPair>
            {quantityRefusal || unitRefusal ? (
              <Text as="p" tone="ink" variant="sentence">
                {quantityRefusal ?? unitRefusal}
              </Text>
            ) : null}
            {!habit && !hasMeasure && trimmedUnit.length > 0 ? (
              <Text as="p" variant="sentence" tone="muted">
                {t("plan.commitmentForm.noMeasureYet", { unit: trimmedUnit })}
              </Text>
            ) : null}
          </>
        ) : null}

        {satisfaction === "evidence" ? (
          <>
            <ChipRow>
              {sources.map((source) => (
                <Chip key={source.key} selected={sourceKey === source.key} onClick={() => pickSource(source)}>
                  {t(source.labelKey)}
                </Chip>
              ))}
            </ChipRow>
            <Field
              label={t("plan.commitmentForm.thresholdLabel")}
              type="number"
              inputMode="numeric"
              min={1}
              step={1}
              value={threshold}
              onChange={(event) => setThreshold(event.target.value)}
              invalid={thresholdRefusal !== undefined}
              hint={thresholdRefusal}
            />
          </>
        ) : null}
      </Section>
      )}

      {error && !ownedRefusal ? (
        <Text as="p" tone="ink" variant="sentence">
          {t(error)}
        </Text>
      ) : null}

      <Button block onClick={handleSubmit} disabled={pending}>
        {t(
          edit
            ? pending
              ? "plan.commitmentForm.saving"
              : "plan.commitmentForm.save"
            : pending
              ? "plan.commitmentForm.submitting"
              : "plan.commitmentForm.submit",
        )}
      </Button>
      {edit ? (
        <Button asChild block variant="outline">
          <Link href={returnTo}>{t("plan.commitmentForm.cancel")}</Link>
        </Button>
      ) : null}
      {foot}
    </Page>
  );
}
