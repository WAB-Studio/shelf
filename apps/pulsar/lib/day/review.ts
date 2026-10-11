import { measureOf, phaseOn } from "@/lib/day/derive";
import type { DeclaredFact, EvidenceDay, Phase, ReviewWeek } from "@/lib/day/types";
import { horizonWeeksOf, weekIndexOf, weekSpan } from "@/lib/day/weeks";

// `measureOf`'s own rule (RP-14), run twice: once over the declared facts of
// the span, once over the evidence days of the span, by `unit`. `unit: null`
// means the goal has no measure yet, so the week's own total is `0` rather
// than matching a fact or an evidence day that carries no unit of its own.
export function totalInSpan(
  unit: string | null,
  facts: DeclaredFact[],
  evidence: EvidenceDay[],
  startsOn: string,
  endsOn: string,
): number {
  if (unit === null) return 0;

  const declared = measureOf(
    unit,
    facts.filter((fact) => fact.day >= startsOn && fact.day <= endsOn),
  );
  const read = evidence.reduce(
    (total, day) =>
      day.unit === unit && day.day >= startsOn && day.day <= endsOn ? total + day.quantity : total,
    0,
  );
  return declared + read;
}

/**
 * What a goal's measure was in each of its own weeks, from week 1 to the
 * week holding `today` — capped at the week holding `horizon`, so a review
 * asked for past the goal's own end never invents weeks it never ran (RP-17).
 * A week with nothing still reads `total: 0`: RP-16's rule that a gap is
 * drawn, never hidden, carried here from the day to the review.
 */
export function measureByWeek(args: {
  openedOn: string;
  horizon: string;
  today: string;
  unit: string | null;
  facts: DeclaredFact[];
  evidence: EvidenceDay[];
  phases: Phase[];
}): ReviewWeek[] {
  const { openedOn, horizon, today, unit, facts, evidence, phases } = args;

  const todayWeek = weekIndexOf(openedOn, today);
  const lastIndex = Math.max(1, Math.min(todayWeek, horizonWeeksOf(openedOn, horizon)));

  const rows: ReviewWeek[] = [];
  for (let index = 1; index <= lastIndex; index++) {
    const { startsOn, endsOn } = weekSpan(openedOn, index, index, horizon);
    rows.push({
      index,
      startsOn,
      endsOn,
      total: totalInSpan(unit, facts, evidence, startsOn, endsOn),
      phaseName: phaseOn(phases, startsOn)?.name ?? null,
      current: index === todayWeek && today < horizon,
    });
  }
  return rows;
}
