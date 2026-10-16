import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";

import { GoalScreen } from "@/components/goal/goal-screen";
import { getPerson } from "@/lib/session";

// Static per route: no title reads a goal or costs a statement (RNP-01).
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("common.titles");
  return { title: t("goal") };
}

// `Meta.dc.html`: the auth gate alone, the same shape `app/page.tsx` and
// `app/metas/nueva/page.tsx` already take — `GoalScreen` owns the fetch and
// the screen both.
export default async function GoalPage({
  params,
}: {
  params: Promise<{ goalId: string }>;
}) {
  const person = await getPerson();
  if (!person) redirect("/entrar");

  const { goalId } = await params;
  return <GoalScreen goalId={goalId} />;
}
