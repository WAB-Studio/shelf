import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";

import { DaylessScreen } from "@/components/one-offs/dayless-screen";
import { getPerson } from "@/lib/session";

// Static per route: no title reads a goal or costs a statement (RNP-01).
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("common.titles");
  return { title: t("oneOffs") };
}

// Same gate as Hoy: `getPerson` is the verified JWT alone, zero round trips.
export default async function DaylessPage() {
  const person = await getPerson();
  if (!person) redirect("/entrar");

  return <DaylessScreen />;
}
