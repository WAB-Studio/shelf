import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";

import { MonthAcrossScreen } from "@/components/across/month-across-screen";
import { getPerson } from "@/lib/session";

// Static per route: no title reads a goal or costs a statement (RNP-01).
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("common.titles");
  return { title: t("month") };
}

// `MesTodas.dc.html` (RP-43): the auth gate alone; `MonthAcrossScreen` owns the fetch.
export default async function MonthAcrossPage() {
  const person = await getPerson();
  if (!person) redirect("/entrar");

  return <MonthAcrossScreen />;
}
