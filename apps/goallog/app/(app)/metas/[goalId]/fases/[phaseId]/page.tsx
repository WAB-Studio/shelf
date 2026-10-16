import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { notFound, redirect } from "next/navigation";

import { PhaseForm } from "@/components/goal/phase-form";
import { loadGoal } from "@/lib/queries/goal";
import { getPerson } from "@/lib/session";
import { civilDateInZone } from "@/lib/zone";

/**
 * A phase's own form (RP-127): `PhaseForm` in its edit mode, prefilled from
 * the phase named in the URL. One query, `loadGoal`, carries the goal's
 * opening, horizon and every phase; a phase not among them, or a goal that is
 * archived or ended, is the same not-found the new-phase route draws.
 */
// Static per route: no title reads a goal or costs a statement (RNP-01).
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("common.titles");
  return { title: t("editPhase") };
}

export default async function EditPhasePage({
  params,
}: {
  params: Promise<{ goalId: string; phaseId: string }>;
}) {
  const [person, { goalId, phaseId }] = await Promise.all([getPerson(), params]);
  if (!person) redirect("/entrar");

  const goal = await loadGoal(goalId);
  if (!goal) notFound();
  if (goal.archivedAt || goal.endedOn) notFound();
  const phase = goal.phases.find((candidate) => candidate.id === phaseId);
  if (!phase) notFound();

  const openedOn = civilDateInZone(new Date(goal.createdAt));
  const existingPhases = goal.phases.map((other) => ({
    name: other.name,
    startsOn: other.startsOn,
    endsOn: other.endsOn,
  }));

  return (
    <PhaseForm
      goalId={goal.id}
      goalName={goal.name}
      openedOn={openedOn}
      horizon={goal.horizon}
      defaultFromWeek={null}
      defaultToWeek={null}
      existingPhases={existingPhases}
      phase={{ id: phase.id, aim: phase.name, startsOn: phase.startsOn, endsOn: phase.endsOn }}
    />
  );
}
