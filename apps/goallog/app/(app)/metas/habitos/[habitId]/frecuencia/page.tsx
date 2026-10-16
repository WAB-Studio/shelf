import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { notFound, redirect } from "next/navigation";

import { CommitmentForm } from "@/components/goal/commitment-form";
import { loadHabit } from "@/lib/queries/habit";
import { getPerson } from "@/lib/session";

// Static per route: no title reads a habit or costs a statement (RNP-01).
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("common.titles");
  return { title: t("cadence") };
}

/**
 * The cadence page of a loose habit (RP-135): the creation form in its cadence-only mode, returning to
 * the habit's screen. A retired habit and one a fact names are «not found».
 */
export default async function HabitCadencePage({ params }: { params: Promise<{ habitId: string }> }) {
  const person = await getPerson();
  if (!person) redirect("/entrar");

  const { habitId } = await params;
  const habit = await loadHabit(habitId);
  if (!habit || habit.retiredOn !== null || habit.factDayCount > 0) notFound();

  return (
    <CommitmentForm
      goalId={null}
      goalName={habit.name}
      hasMeasure={false}
      measureUnit={null}
      sources={[]}
      edit={{ commitmentId: habit.id, cadence: habit.cadence }}
    />
  );
}
