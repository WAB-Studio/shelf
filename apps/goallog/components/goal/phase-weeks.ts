import { daysBetween, horizonWeeksOf, weekIndexOf, weekSpan } from "@/lib/day/weeks";
import { phaseWithinHorizon, type PhaseSpan } from "@/lib/validation/plan";

export { daysBetween };

// The longest a goal runs, in weeks: `/metas/nueva`'s own cap, and the stand-in for a goal with no end.
export const MAX_GOAL_WEEKS = 520;

// The 1-based Monday-to-Sunday goal week `day` falls in —
// what `Meta.dc.html` calls "semanas 1–4" for a phase's own span. The one
// convention every screen that counts a goal's weeks reuses; never a second
// one. `lib/day/weeks.ts`'s
// own `weekIndexOf`, under the name every caller here already uses.
export const weekIndex = weekIndexOf;

// How many goal weeks a horizon holds, its partial last week included —
// `lib/day/weeks.ts`'s `horizonWeeksOf`.
export function horizonWeeks(openedOn: string, horizon: string): number;
export function horizonWeeks(openedOn: string, horizon: string | null): number | null;
export function horizonWeeks(openedOn: string, horizon: string | null): number | null {
  return horizonWeeksOf(openedOn, horizon);
}

// The civil dates a span of 1-based weeks covers, counted from the goal's
// own opening — `lib/day/weeks.ts`'s own `weekSpan`, under the name every
// caller here already uses. Week 1 is the partial week from the opening day
// to its first Sunday.
export function weeksToPhaseSpan(
  openedOn: string,
  fromWeek: number,
  toWeek: number,
  horizon?: string | null,
): { startsOn: string; endsOn: string } {
  return weekSpan(openedOn, fromWeek, toWeek, horizon);
}

// The span typed weeks mean for a phase that already has dates. An edge whose week the person
// left alone keeps its stored date (an import writes dates, not weeks); a moved edge snaps to
// its week's Monday or Sunday. Two phases may share a week, so weeks never judge overlap.
export function phaseSpanKeeping(
  openedOn: string,
  fromWeek: number,
  toWeek: number,
  horizon: string | null,
  kept?: PhaseSpan,
): PhaseSpan {
  const typed = weeksToPhaseSpan(openedOn, fromWeek, toWeek, horizon);
  if (!kept) return typed;
  return {
    startsOn: fromWeek === weekIndexOf(openedOn, kept.startsOn) ? kept.startsOn : typed.startsOn,
    endsOn: toWeek === weekIndexOf(openedOn, kept.endsOn) ? kept.endsOn : typed.endsOn,
  };
}

// The span the new-phase form opens on (RP-15): from the week after the last
// phase, up to four weeks long, every week of it ending within the horizon —
// so the default passes the form's own checks; the partial last week fits and
// ends on the goal's last day. `null` when no week is left: the form opens empty.
export function defaultPhaseWeeks({
  openedOn,
  horizon,
  phases,
}: {
  openedOn: string;
  horizon: string | null;
  phases: PhaseSpan[];
}): { from: number; to: number } | null {
  const lastEndsOn = phases.reduce<string | null>(
    (latest, phase) => (latest === null || phase.endsOn > latest ? phase.endsOn : latest),
    null,
  );
  const from = lastEndsOn ? weekIndexOf(openedOn, lastEndsOn) + 1 : 1;
  const fits = (week: number) =>
    week <= (horizonWeeksOf(openedOn, horizon) ?? MAX_GOAL_WEEKS) &&
    phaseWithinHorizon(weekSpan(openedOn, from, week, horizon), horizon);
  if (!fits(from)) return null;
  let to = from;
  while (to < from + 3 && fits(to + 1)) to += 1;
  return { from, to };
}
