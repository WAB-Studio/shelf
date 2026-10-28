import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";

import { MonthAcrossScreen } from "@/components/across/month-across-screen";
import { parseMonthParam } from "@/lib/plan/month-param";
import { getPerson } from "@/lib/session";
import { todayInZone } from "@/lib/zone";

// Static per route: no title reads a goal or costs a statement (RNP-01).
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("common.titles");
  return { title: t("month") };
}

// `MesTodas.dc.html` (RP-142): the auth gate and the shape of `?mes=`; `MonthAcrossScreen` owns the fetch.
export default async function MonthAcrossPage({
  searchParams,
}: {
  searchParams: Promise<{ mes?: string | string[] }>;
}) {
  const person = await getPerson();
  if (!person) redirect("/entrar");

  const today = todayInZone();
  // The bounds come with the read: `MonthAcrossScreen` sends a month past them back to this one.
  const month = parseMonthParam((await searchParams).mes, today, "0000-01", "9999-12");
  if (month.kind === "redirect") redirect("/mes");

  return <MonthAcrossScreen month={month.kind === "this" ? undefined : month.month} today={today} />;
}
