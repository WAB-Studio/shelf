import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { notFound, redirect } from "next/navigation";

import { PhaseForm } from "@/components/goal/phase-form";
import { defaultPhaseWeeks } from "@/components/goal/phase-weeks";
import { loadGoal } from "@/lib/queries/goal";
import { getPerson } from "@/lib/session";
import { civilDateInZone } from "@/lib/zone";

/**
 * `CompromisoNuevo.dc.html`'s own shape, for a phase (RP-15): the auth gate
 * and the one query `PhaseForm` needs — the goal's own opening, horizon and
 * every phase it already has, all in `loadGoal`'s single statement
 * (`lib/queries/goal.ts`), the same shape `app/metas/[goalId]/compromisos/
 * nuevo/page.tsx` takes for a commitment. Prefills the next open span: from
 * the week after the last phase ends (1 with none), four weeks long at most,
 * every week of it within the goal's horizon; empty when no week fits.
 */
// Static per route: no title reads a goal or costs a statement (RNP-01).
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("common.titles");
  return { title: t("newPhase") };
}

export default async function NewPhasePage({
  params,
}: {
  params: Promise<{ goalId: string }>;
}) {
  const person = await getPerson();
  if (!person) redirect("/entrar");

  const { goalId } = await params;
  const goal = await loadGoal(goalId);
  if (!goal) notFound();
  // RP-24: an archived or ended goal draws no "Añadir una fase" way in; a
  // direct visit to this route is refused the same way `listGoals` (open-only)
  // already 404s `compromisos/nuevo` for one.
  if (goal.archivedAt || goal.endedOn) notFound();

  const openedOn = civilDateInZone(new Date(goal.createdAt));
  const existingPhases = goal.phases.map((phase) => ({
    name: phase.name,
    startsOn: phase.startsOn,
    endsOn: phase.endsOn,
  }));
  const span = defaultPhaseWeeks({ openedOn, horizon: goal.horizon, phases: existingPhases });

  return (
    <PhaseForm
      goalId={goal.id}
      goalName={goal.name}
      openedOn={openedOn}
      horizon={goal.horizon}
      defaultFromWeek={span?.from ?? null}
      defaultToWeek={span?.to ?? null}
      existingPhases={existingPhases}
    />
  );
}
