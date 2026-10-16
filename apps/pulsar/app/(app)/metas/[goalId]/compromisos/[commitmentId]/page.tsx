import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { notFound, redirect } from "next/navigation";

import { CommitmentForm } from "@/components/goal/commitment-form";
import { loadGoal } from "@/lib/queries/goal";
import { getPerson } from "@/lib/session";

// Static per route: no title reads a goal or costs a statement (RNP-01).
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("common.titles");
  return { title: t("cadence") };
}

/**
 * The cadence page of a commitment (RP-127): the creation form in its cadence-only mode. A retired
 * commitment, one a fact names, another goal's and another person's are all «not found»; the act
 * refuses the same rows if one is opened before a fact lands.
 */
export default async function CommitmentCadencePage({
  params,
}: {
  params: Promise<{ goalId: string; commitmentId: string }>;
}) {
  const person = await getPerson();
  if (!person) redirect("/entrar");

  const { goalId, commitmentId } = await params;
  const goal = await loadGoal(goalId);
  const commitment = goal?.commitments.find((candidate) => candidate.id === commitmentId);
  if (!goal || !commitment || commitment.retiredAt !== null || commitment.factDayCount > 0) notFound();

  return (
    <CommitmentForm
      goalId={goal.id}
      goalName={goal.name}
      hasMeasure={goal.measureUnit !== null}
      measureUnit={goal.measureUnit}
      sources={[]}
      edit={{ commitmentId: commitment.id, cadence: commitment.cadence }}
    />
  );
}
