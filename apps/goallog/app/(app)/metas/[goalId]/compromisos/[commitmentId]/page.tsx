import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { notFound, redirect } from "next/navigation";

import { CommitmentActions } from "@/components/goal/commitment-actions";
import { CommitmentForm } from "@/components/goal/commitment-form";
import { CommitmentScreen } from "@/components/goal/commitment-screen";
import { loadGoalEvidence, loadGoalForm, withEvidenceDays } from "@/lib/queries/goal";
import { todayInZone } from "@/lib/zone";
import { getPerson } from "@/lib/session";

// Static per route: no title reads a goal or costs a statement (RNP-01).
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("common.titles");
  return { title: t("cadence") };
}

/**
 * A commitment's own screen (RP-127): the creation form in its cadence-only mode while no fact names it,
 * its name and a cadence read as it was once one does. A retired commitment, another goal's and another
 * person's are «not found»; the act refuses the same rows if a fact lands while the form is open.
 */
export default async function CommitmentCadencePage({
  params,
}: {
  params: Promise<{ goalId: string; commitmentId: string }>;
}) {
  const person = await getPerson();
  if (!person) redirect("/entrar");

  const { goalId, commitmentId } = await params;
  // The evidence read rides beside the form, never after it (RNP-03).
  const [goal, evidence] = await Promise.all([loadGoalForm(goalId), loadGoalEvidence(goalId)]);
  const found = goal?.commitments.find((candidate) => candidate.id === commitmentId);
  if (!goal || !found || found.retiredAt !== null) notFound();
  // A day the source met counts like a day written: the frequency is as locked as a declared one's.
  const commitment = withEvidenceDays(found, evidence, todayInZone());
  if (commitment.factDayCount > 0) {
    return <CommitmentScreen goalId={goal.id} goalName={goal.name} commitment={commitment} />;
  }

  return (
    <CommitmentForm
      goalId={goal.id}
      goalName={goal.name}
      hasMeasure={goal.measureUnit !== null}
      measureUnit={goal.measureUnit}
      sources={[]}
      edit={{
        commitmentId: commitment.id,
        cadence: commitment.cadence,
        name: commitment.name,
        fulfils:
          commitment.satisfiedBy.kind === "evidence" && commitment.sourceLabelKey
            ? { labelKey: commitment.sourceLabelKey, threshold: commitment.satisfiedBy.threshold, unit: commitment.satisfiedBy.unit }
            : undefined,
      }}
      foot={
        <CommitmentActions
          commitmentId={commitment.id}
          goalId={goal.id}
          name={commitment.name}
          factDayCount={commitment.factDayCount}
        />
      }
    />
  );
}
