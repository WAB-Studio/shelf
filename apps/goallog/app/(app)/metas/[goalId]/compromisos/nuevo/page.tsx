import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { notFound, redirect } from "next/navigation";

import { evidenceSources } from "@/db/schema";
import { CommitmentForm } from "@/components/goal/commitment-form";
import { listGoals } from "@/lib/queries/goal";
import { getPerson, withGoalsDb } from "@/lib/session";
import { sourceKey } from "@/i18n/translator";

/**
 * `CompromisoNuevo.dc.html` (RP-12): the auth gate, the goal it belongs to
 * and the evidence catalogue — `CommitmentForm` owns the screen itself, the
 * same shape `app/metas/nueva/page.tsx` takes for opening a goal. Fanned with
 * `Promise.all` (AGENTS.md "## Code"): the goal's own name and whether it
 * already has a measure never depend on which sources exist.
 */
// Static per route: no title reads a goal or costs a statement (RNP-01).
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("common.titles");
  return { title: t("newCommitment") };
}

export default async function NewCommitmentPage({
  params,
}: {
  params: Promise<{ goalId: string }>;
}) {
  const person = await getPerson();
  if (!person) redirect("/entrar");

  const { goalId } = await params;

  const [goals, sources] = await Promise.all([
    listGoals(),
    withGoalsDb((tx) =>
      tx
        .select({ key: evidenceSources.key, labelKey: evidenceSources.labelKey, unit: evidenceSources.unit })
        .from(evidenceSources),
    ),
  ]);
  const sourceChoices = sources.map((source) => ({ ...source, labelKey: sourceKey(source.labelKey) }));

  const goal = goals.find((candidate) => candidate.id === goalId);
  if (!goal) notFound();

  return (
    <CommitmentForm
      goalId={goal.id}
      goalName={goal.name}
      hasMeasure={goal.measureUnit !== null}
      measureUnit={goal.measureUnit}
      sources={sourceChoices}
    />
  );
}
