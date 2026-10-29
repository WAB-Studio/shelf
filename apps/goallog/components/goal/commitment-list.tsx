import type { ReactNode } from "react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";

import type { Translator } from "@/i18n/translator";
import type { Cadence } from "@/lib/day/types";
import type { GoalCommitment } from "@/lib/queries/goal";
import { weekdaysSentence } from "@/lib/day/row-phrases";
import { evidenceUnitWords } from "@/lib/evidence/unit-words";
import { Button, Figure, Flex, Section, Text } from "@/components/ui";

import { CommitmentRow } from "./retire-sheet";


// The count in words, section-label style ("ocho compromisos", "tres
// fases"): `goal.countWords` covers what a real plan holds; past its length
// the plain numeral still reads correctly, never a placeholder. Exported: the
// goal screen's own phases section needs the identical wording.
export function countWord(n: number, t: Translator, feminine = false): string {
  // Only «una» differs from the masculine list, so the feminine one stops at
  // 2 and falls through to the shared words after it.
  const own = feminine ? (t.raw("goal.countWordsFeminine") as string[]) : [];
  if (own[n] !== undefined) return own[n];
  const words = t.raw("goal.countWords") as string[];
  return words[n] ?? String(n);
}

// `Meta.dc.html`'s own cadence phrasing — full words, unlike `day.cadence`'s
// abbreviated one, which a day row's tighter space asks for instead.
function cadenceWords(cadence: Cadence, t: Translator): string {
  switch (cadence.kind) {
    case "daily":
      return t("goal.cadence.daily");
    case "weekdays": {
      return weekdaysSentence((key, values) => t(key, values), cadence.days, t.raw("goal.cadence.weekdayFull") as string[]);
    }
    case "times_per_week":
      return t("goal.cadence.timesPerWeek", { count: cadence.count });
    case "every_n_days":
      // "Every 1 day" reads exactly as daily, the same call `day-row.tsx`
      // already makes for the day's own label.
      return cadence.n === 1
        ? t("goal.cadence.daily")
        : t("goal.cadence.everyNDays", { n: cadence.n });
    case "times_per_month":
      return t("goal.cadence.timesPerMonth", { count: cadence.count });
  }
}

// What satisfies the commitment, in quiet: a tap, the quantity's own unit —
// the person's own word, never resolved against a catalogue — or the
// evidence threshold and source ("1 búsqueda · diccionario").
function satisfactionWords(commitment: GoalCommitment, t: Translator): ReactNode {
  switch (commitment.satisfiedBy.kind) {
    case "tap":
      return t("goal.satisfaction.tap");
    case "quantity":
      return (
        <Figure
          value={commitment.satisfiedBy.target}
          unit={commitment.satisfiedBy.unit}
          variant="meta"
        />
      );
    case "evidence": {
      const { threshold, unit } = commitment.satisfiedBy;
      const labelKey = commitment.sourceLabelKey;
      const source = labelKey ? t(labelKey) : "";
      const unitWords = labelKey ? evidenceUnitWords({ labelKey, unit }, threshold, t) : unit;
      return (
        <>
          <Figure value={threshold} unit={unitWords} variant="meta" /> · {source}
        </>
      );
    }
  }
}

/**
 * `Meta.dc.html`'s commitment rows (RP-12, RP-13, RP-14): the name on the
 * left, the cadence over the satisfaction right-aligned in mono. A retired
 * commitment stays in the list — never hidden — marked in its own second
 * line rather than by hue, since this design has none for it. Below the
 * rows, the goal's own way into `CompromisoNuevo.dc.html` (docs/goallog/
 * DESIGN.md "A goal adds a commitment from its own screen"): solid while the
 * list is empty, because then it is the only thing the screen asks for;
 * outlined once a first commitment already carries the goal.
 */
export async function CommitmentList({
  goalId,
  commitments,
  archived = false,
}: {
  goalId: string;
  commitments: GoalCommitment[];
  // RP-24: an archived goal draws no way to add a commitment — the way a
  // retired one still shows the ones it already has, never hidden.
  archived?: boolean;
}) {
  const t = await getTranslations();
  // A retired commitment stays in the list — never hidden (RP-13) — but it
  // no longer asks anything of the goal, so the count above it names what is
  // still active and adds the retired ones apart: it always matches the rows.
  const activeCount = commitments.filter((commitment) => commitment.retiredAt === null).length;

  return (
    <Section
      label={t("goal.detail.commitmentsCount", {
        word: countWord(activeCount, t),
        count: activeCount,
        retired: commitments.length - activeCount,
      })}
    >
      {commitments.map((commitment) => (
        <CommitmentRow
          key={commitment.id}
          commitmentId={commitment.id}
          name={commitment.name}
          retired={commitment.retiredAt !== null}
          retiredLabel={t("goal.commitments.retired")}
          factDayCount={commitment.factDayCount}
          goalId={goalId}
          trailing={
            <Flex direction="column" align="end">
              <Text as="span" variant="sentence" tone="muted">
                {cadenceWords(commitment.cadence, t)}
              </Text>
              <Text as="span" variant="sentence" tone="muted">
                {satisfactionWords(commitment, t)}
              </Text>
            </Flex>
          }
        />
      ))}
      {!archived ? (
        <Button asChild variant={commitments.length > 0 ? "outline" : "solid"} block>
          <Link href={`/metas/${goalId}/compromisos/nuevo`}>{t("goal.commitments.add")}</Link>
        </Button>
      ) : null}
    </Section>
  );
}
