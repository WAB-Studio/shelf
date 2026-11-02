import type { CommitmentPlan, DeclaredFact, SatisfiedBy } from "./types";

// RP-148: what a day asks of a quantity commitment — the day's own target when the person lowered it, else the plan's.
export function dayTargetOf(target: number, dayFacts: readonly Pick<DeclaredFact, "dayTarget">[]): number {
  const own = dayFacts.map((fact) => fact.dayTarget).filter((value): value is number => value != null);
  return own.length > 0 ? Math.min(...own) : target;
}

// Whether one day's declared facts did what the commitment asks: any fact for a tap, the day's target for a
// quantity. A short day is «en parte» and is not one of a weekly or monthly count's times (RP-148). Its twin in
// SQL is `metFact` in lib/queries/rows.ts.
export function dayMet(satisfiedBy: SatisfiedBy, dayFacts: readonly DeclaredFact[]): boolean {
  if (dayFacts.length === 0) return false;
  if (satisfiedBy.kind !== "quantity") return true;
  const quantity = dayFacts.reduce((total, fact) => total + (fact.quantity ?? 0), 0);
  return quantity >= dayTargetOf(satisfiedBy.target, dayFacts);
}

// The days in `facts` on which `plan` was met, kept by `keep`.
export function metDays(
  plan: Pick<CommitmentPlan, "id" | "satisfiedBy">,
  facts: readonly DeclaredFact[],
  keep: (day: string) => boolean,
): Set<string> {
  const byDay = new Map<string, DeclaredFact[]>();
  for (const fact of facts) {
    if (fact.commitmentId !== plan.id || !keep(fact.day)) continue;
    byDay.set(fact.day, [...(byDay.get(fact.day) ?? []), fact]);
  }
  return new Set([...byDay].filter(([, dayFacts]) => dayMet(plan.satisfiedBy, dayFacts)).map(([day]) => day));
}
