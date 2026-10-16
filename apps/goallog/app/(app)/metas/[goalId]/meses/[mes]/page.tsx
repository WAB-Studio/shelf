import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { notFound, redirect } from "next/navigation";

import { MonthScreen } from "@/components/month/month-screen";
import { getPerson } from "@/lib/session";

// Static per route: no title reads a goal or costs a statement (RNP-01).
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("common.titles");
  return { title: t("goalMonth") };
}

// `Mes`, `MesArrastre`, `MesVacio`, `MesCerrado` (RP-30, RP-31, RP-32): the auth gate
// and the segment's shape; `MonthScreen` owns the fetch and the span check. The pattern is the same one the amount sheet and
// the actions speak (`lib/validation/budget.ts`).
export default async function MonthPage({
  params,
}: {
  params: Promise<{ goalId: string; mes: string }>;
}) {
  const person = await getPerson();
  if (!person) redirect("/entrar");

  const { goalId, mes } = await params;
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(mes)) notFound();

  return <MonthScreen goalId={goalId} month={mes} />;
}
