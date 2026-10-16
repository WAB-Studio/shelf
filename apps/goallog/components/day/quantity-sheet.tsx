"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";

import { declareFact, undoFact } from "@/app/actions/facts";
import { timeChipsAround } from "@/lib/day/time-chips";
import { formatQuantity, isTimeUnit } from "@/lib/units/time";
import { quantitySchema } from "@/lib/validation/fact";
import { useTimeWords } from "@/components/ui/figure";
import { Button, Chip, Field, Flex, Sheet, Text } from "@/components/ui";
import { type MessageKey } from "@/i18n/translator";

export type QuantitySheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  commitmentId: string;
  name: string;
  // The plan's own number and unit (RP-03): never typed, only ever read off
  // the commitment and offered back.
  target: number;
  unit: string;
  // Today's own fact, only when the row is already done (RP-05): its
  // presence is what turns the sheet from "declare" into "declared, and
  // undoable". Reopening prefills the figure and note it actually holds,
  // never the plan's target again.
  factId?: string;
  loggedQuantity?: number | null;
  loggedNote?: string | null;
  // The past day the row stands on (RP-06); absent on Hoy.
  day?: string;
  drawnToday?: string;
};

// Four consecutive integers, the target second — `HoyCantidad.dc.html`'s own
// spread, never a fifth and never a menu (docs/goallog/DESIGN.md "Decisions
// taken here"). `target` is always >=1 (the column's own CHECK), so `target
// - 1` only ever goes non-positive at `target === 1`, the one case with no
// smaller integer to offer: `[1, 2, 3, 4]`, with 1 — still the target —
// selected.
function chipsAround(target: number): number[] {
  if (target <= 1) return [1, 2, 3, 4];
  return [target - 1, target, target + 1, target + 2];
}

// A time unit offers the board's wider spread; every other unit the four neighbours.
function chipsFor(target: number, unit: string): number[] {
  return isTimeUnit(unit) ? timeChipsAround(target) : chipsAround(target);
}

/**
 * Takes a commitment's number in the same gesture that satisfies it (RP-03),
 * plus one optional line (RP-04). Offered as chips, the target already
 * selected; typing is the exception a person reaches for on purpose, never
 * the path the sheet opens on (docs/goallog/DESIGN.md "Decisions taken
 * here"). Accepting never asks again — no confirmation stands between the
 * tap and the closed sheet.
 */
export function QuantitySheet({
  open,
  onOpenChange,
  commitmentId,
  name,
  target,
  unit,
  factId,
  loggedQuantity,
  loggedNote,
  day,
  drawnToday,
}: QuantitySheetProps) {
  const t = useTranslations();
  const words = useTimeWords();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<MessageKey | null>(null);
  const [selected, setSelected] = useState(loggedQuantity ?? target);
  const [customMode, setCustomMode] = useState(false);
  const [customValue, setCustomValue] = useState("");
  const [note, setNote] = useState(loggedNote ?? "");
  const [wasOpen, setWasOpen] = useState(open);

  const chips = chipsFor(target, unit);

  // Every open starts where today's own row stands: the logged figure and
  // note when the row is done (RP-04, RP-05), the plan's own target and a
  // blank line otherwise — never a leftover from a prior open. Adjusted
  // during render rather than an effect — the recommended way to reset
  // state on a prop change, since it bails out before a second paint.
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setSelected(loggedQuantity ?? target);
      setCustomMode(loggedQuantity != null && !chipsFor(target, unit).includes(loggedQuantity));
      setCustomValue(loggedQuantity != null ? String(loggedQuantity) : "");
      setNote(loggedNote ?? "");
      setError(null);
    }
  }

  function pickChip(value: number) {
    setCustomMode(false);
    setSelected(value);
  }

  // The same bound the server enforces (`quantitySchema`, `lib/validation/
  // fact.ts`), run here first: a number this schema refuses is a number
  // `declareFact` would have refused too, never a raw Postgres error.
  function customQuantity(): number | null {
    const trimmed = customValue.trim();
    if (trimmed.length === 0) return null;
    const parsed = quantitySchema.safeParse(Number(trimmed));
    return parsed.success ? parsed.data : null;
  }

  // The action's promise resolves before the router commits the page it
  // revalidated, so closing outside the transition left the row showing
  // the props from before the write: a tap in that gap reopened the sheet as
  // undone, and it never re-read the fact once it landed. Inside the same
  // transition the close commits together with the fresh row.
  function settle(result: { ok: true } | { ok: false; error: MessageKey }) {
    startTransition(() => {
      if (result.ok) onOpenChange(false);
      else setError(result.error);
    });
  }

  function handleAccept() {
    if (pending) return;
    const quantity = customMode ? customQuantity() : selected;
    if (quantity == null) {
      setError("day.errors.quantityInvalid");
      return;
    }
    const trimmedNote = note.trim();
    setError(null);

    startTransition(async () => {
      // A request that never arrived throws: the sheet stays open with what was typed, never the error page.
      const result = await declareFact({
        commitmentId,
        quantity,
        note: trimmedNote.length > 0 ? trimmedNote : undefined,
        // "Cambiar", not "Anotar": a row already carrying a fact today
        // replaces it whole, server-side, in one transaction — never a
        // second `declareFact` beside the first (25 and 30 would both land
        // in `goals.facts`).
        replace: factId != null,
        day: day ?? drawnToday,
        onHoy: day === undefined && drawnToday !== undefined ? true : undefined,
      }).catch(() => null);
      if (result) settle(result);
    });
  }

  // The same gesture the day row itself offers a done `tap` row (RP-05): no
  // confirm sheet here either, since this sheet's own "Deshacer" already is
  // the confirm — a person who opened it to look can still just close it.
  function handleUndo() {
    if (pending || !factId) return;
    setError(null);

    startTransition(async () => {
      const result = await undoFact({ factId }).catch(() => null);
      if (result) settle(result);
    });
  }

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      label={name}
      title={day ? t("day.quantitySheet.questionPast") : t("day.quantitySheet.question")}
    >
      <Flex gap="2" wrap="wrap" align="center">
        {chips.map((value) => (
          <Chip
            key={value}
            mono
            selected={!customMode && selected === value}
            onClick={() => pickChip(value)}
          >
            {isTimeUnit(unit) ? formatQuantity(value, unit, words) : value}
          </Chip>
        ))}
        {/* The heading stays neutral; a unit inside it would need a gender.
            A time carries its own «h» and «min», so no word follows it. */}
        {isTimeUnit(unit) ? null : (
          <Text variant="meta" tone="quiet">
            {unit}
          </Text>
        )}
      </Flex>

      {customMode ? (
        <Field
          label={t(isTimeUnit(unit) ? "day.quantitySheet.customLabelMinutes" : "day.quantitySheet.customLabel")}
          type="number"
          inputMode="numeric"
          min={1}
          step={1}
          value={customValue}
          onChange={(event) => setCustomValue(event.target.value)}
          autoFocus
        />
      ) : (
        <Button variant="ghost" onClick={() => setCustomMode(true)}>
          {t("day.quantitySheet.otherAmount")}
        </Button>
      )}

      <Field
        label={t("day.quantitySheet.noteLabel")}
        placeholder={t("day.quantitySheet.notePlaceholder")}
        value={note}
        onChange={(event) => setNote(event.target.value)}
      />

      {error ? (
        <Text as="p" variant="sentence">
          {t(error)}
        </Text>
      ) : null}

      <Button block onClick={handleAccept} disabled={pending}>
        {factId ? t("day.quantitySheet.change") : t("day.quantitySheet.accept")}
      </Button>
      {factId ? (
        <Button block variant="outline" onClick={handleUndo} disabled={pending}>
          {t("day.quantitySheet.undo")}
        </Button>
      ) : null}
    </Sheet>
  );
}
