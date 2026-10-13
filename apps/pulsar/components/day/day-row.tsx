"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";

import { declareFact, undoFact } from "@/app/actions/facts";
import { cadencePhrase, flexibleWords, metPhrase, partialPair, rowMeta } from "@/lib/day/row-phrases";
import type { Cadence } from "@/lib/day/types";
import { formatQuantity } from "@/lib/units/time";
import { useTimeWords } from "@/components/ui/figure";
import { Figure, Mark, Row, Text, type MarkState } from "@/components/ui";

import { QuantitySheet } from "./quantity-sheet";
import { type MessageKey } from "@/i18n/translator";

export type DayRowKind = "tap" | "quantity" | "evidence";

export type DayRowProps = {
  commitmentId: string;
  name: string;
  // The goal a row of a large or a small goal names, before its other words.
  goalName?: string;
  // What satisfies the commitment (RP-02, RP-03, RP-07): a `tap` row calls
  // `declareFact` outright, an `evidence` row never calls it at all — RP-07
  // says evidence takes no act from the person — and a `quantity` row opens
  // the quantity sheet.
  kind: DayRowKind;
  markState: MarkState;
  // An evidence row's ask, and once met what it got and its source (RP-08,
  // RP-09): `got` and `source` stay null until the row is satisfied.
  evidence?: { asks: string; got: string | null; source: string | null };
  // The plan's own number, unit and cadence for a `quantity` row (RP-03):
  // null for every other kind, which needs none of them.
  target?: number | null;
  unit?: string | null;
  cadence?: Cadence;
  // Days a flexible commitment has a fact in its week or month, the day's own
  // included; absent for a cadence counted by the day.
  periodDone?: number;
  // Today's own fact for this commitment, the most recent one when more than
  // one landed (`lib/queries/day.ts`'s `LoggedFact`) — undefined while the
  // row is still empty, which is exactly when there is nothing to undo yet.
  factId?: string;
  // What a `quantity` commitment actually logged, read back rather than the
  // plan's own target (RP-04's own "a done row shows what was logged").
  loggedQuantity?: number | null;
  // The line the person wrote alongside the fact (RP-04), drawn quiet under
  // the row when there is one.
  note?: string | null;
  // The past day this row stands on (RP-06): every fact it writes names that
  // day. Absent on Hoy, where the action decides today itself.
  day?: string;
  // «anotado el lunes 21», set only when the fact was written on a later day
  // than the one drawn: the day it counts for and the day it was written are
  // never read as one (RP-06).
  writtenLabel?: string;
  // «07:40»: the hour a done commitment was written.
  writtenTime?: string;
  // A flexible commitment already met in its period, asking nothing today:
  // drawn muted, tappable all the same. `periodDone` says how far it went.
  quiet?: boolean;
};

/**
 * One commitment's row (RP-01, RP-02, RP-05, RP-08). A `tap` commitment is
 * satisfied outright, and a second tap on a done one undoes it through
 * `undoFact` — the same gesture that made it unmakes it, no confirm sheet
 * (RP-05). A `quantity` row's tap always opens
 * `QuantitySheet`, done or not: calling `declareFact` bare would only ever
 * come back `day.errors.quantityRequired`, and a done row needs the sheet
 * anyway to show what it logged and offer `Deshacer`. An `evidence` row is
 * never tappable at all, satisfied or not: nothing here calls `declareFact`
 * or `undoFact` for it (RP-05: a derived fact belongs to the app that
 * recorded it).
 */
export function DayRow({
  commitmentId,
  name,
  goalName,
  kind,
  markState,
  evidence,
  target,
  unit,
  cadence,
  periodDone,
  factId,
  loggedQuantity,
  note,
  day,
  writtenLabel,
  writtenTime,
  quiet,
}: DayRowProps) {
  const t = useTranslations();
  const words = useTimeWords();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<MessageKey | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

  const tappable = kind !== "evidence";
  // A quiet row has no slot, so what it holds today is the fact itself.
  const done = quiet ? factId !== undefined : markState === "declared";
  // A done row's second line is what the person actually logged, never the
  // plan's target. A time unit prints as «1 h 30 min» (RP-35); any other keeps the
  // commitment's own word.
  const amount =
    kind === "quantity"
      ? done && loggedQuantity != null && unit != null
        ? formatQuantity(loggedQuantity, unit, words)
        : target != null && unit != null
          ? formatQuantity(target, unit, words)
          : undefined
      : undefined;
  const cadenceText = cadence
    ? cadencePhrase((key, values) => t(key, values), cadence, {
        weekdayShort: t.raw("day.cadence.weekdayName") as string[],
        weekdayPlural: t.raw("day.cadence.weekdayPlural") as string[],
      })
    : null;
  const progress = cadence
    ? (flexibleWords({ cadence, periodDone: periodDone ?? null }, (key, values) => t(key, values))?.progress ?? null)
    : null;
  const metWords =
    quiet && cadence
      ? metPhrase((key, values) => t(key, values), { cadence, periodDone })
      : null;
  const meta = rowMeta((key, values) => t(key, values), {
    kind,
    done: markState === "declared",
    quiet: Boolean(quiet),
    cadenceText: progress ? null : cadenceText,
    amount,
    evidence,
    status: metWords ?? progress,
    writtenTime,
    writtenLabel,
    partial:
      kind === "quantity" && loggedQuantity != null && factId !== undefined && target != null && unit != null
        ? partialPair(formatQuantity(loggedQuantity, unit, words), formatQuantity(target, unit, words), unit)
        : null,
  });

  const metaNodes =
    goalName || meta
      ? [
          ...(goalName ? [goalName, ...(meta ? [" · "] : [])] : []),
          ...(meta ?? []).map((part, index) =>
            "figure" in part ? <Figure key={index} value={part.figure} variant="meta" /> : part.text,
          ),
        ]
      : undefined;

  function handleTap() {
    if (!tappable || pending) return;
    setError(null);

    if (kind === "quantity") {
      setSheetOpen(true);
      return;
    }

    startTransition(() => {
      // Done already: this tap undoes it, never declares a second fact
      // beside it.
      const action = done && factId ? undoFact({ factId }) : declareFact({ commitmentId, day });
      void action.then((result) => {
        if (!result.ok) setError(result.error);
      });
    });
  }

  return (
    <>
      <Row
        leading={<Mark state={markState} quiet={quiet} />}
        quiet={quiet}
        name={name}
        meta={metaNodes}
        metaVariant="sentence"
        onClick={handleTap}
        disabled={!tappable || pending}
      />
      {note ? (
        <Text as="p" variant="sentence">
          {note}
        </Text>
      ) : null}
      {error ? (
        <Text as="p" variant="sentence">
          {t(error)}
        </Text>
      ) : null}
      {kind === "quantity" ? (
        <QuantitySheet
          open={sheetOpen}
          onOpenChange={setSheetOpen}
          commitmentId={commitmentId}
          name={name}
          target={target ?? 0}
          unit={unit ?? ""}
          factId={factId}
          loggedQuantity={loggedQuantity}
          loggedNote={note}
          day={day}
        />
      ) : null}
    </>
  );
}
