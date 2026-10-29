import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";

import { NewGoalForm } from "@/components/goal/new-goal-form";
import { getPerson } from "@/lib/session";

// Static per route: no title reads a goal or costs a statement (RNP-01).
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("common.titles");
  return { title: t("newGoal") };
}

// The least it takes to open a goal (RP-11, `MetaNueva.dc.html`): the whole
// screen is `NewGoalForm`'s own — this file is the auth gate and nothing else,
// the same shape `app/page.tsx` already takes for the day.
export default async function NewGoalPage() {
  const person = await getPerson();
  if (!person) redirect("/entrar");

  return <NewGoalForm />;
}
