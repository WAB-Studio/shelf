import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";

import { PlanScreen } from "@/components/plan/plan-screen";
import { getPerson } from "@/lib/session";

// Static per route: no title reads a goal or costs a statement (RNP-01).
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("roadmap.plan");
  return { title: t("title") };
}

// `RoadmapPlan` / `RoadmapSinRitmo` (RP-50, RP-53): the auth gate alone;
// `PlanScreen` owns the fetch.
export default async function PlanPage({
  params,
  searchParams,
}: {
  params: Promise<{ goalId: string }>;
  searchParams: Promise<{ todo?: string | string[] }>;
}) {
  const person = await getPerson();
  if (!person) redirect("/entrar");

  const { goalId } = await params;
  const { todo } = await searchParams;
  return <PlanScreen goalId={goalId} all={todo === "1"} />;
}
