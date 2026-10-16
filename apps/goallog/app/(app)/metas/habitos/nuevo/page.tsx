import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";

import { CommitmentForm } from "@/components/goal/commitment-form";
import { getPerson } from "@/lib/session";

// Static per route: no title reads a goal or costs a statement (RNP-01).
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("common.titles");
  return { title: t("newHabit") };
}

/**
 * `HabitosSueltos` (RP-100): the commitment form with no goal. A habit has no
 * evidence source, so the catalogue is not read.
 */
export default async function NewHabitPage() {
  const person = await getPerson();
  if (!person) redirect("/entrar");

  const t = await getTranslations("common.nav");
  return <CommitmentForm goalId={null} goalName={t("goals")} hasMeasure={false} measureUnit={null} sources={[]} />;
}
