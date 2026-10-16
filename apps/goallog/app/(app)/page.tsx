import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";

import { DayScreen } from "@/components/day/day-screen";
import { getPerson } from "@/lib/session";

// Static per route: no title reads a goal or costs a statement (RNP-01).
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("common.titles");
  return { title: t("today") };
}

// RP-01: `/` opens on today. `getPerson` is the verified JWT alone, zero
// round trips, so the gate costs nothing before the day itself is fetched.
export default async function HomePage() {
  const person = await getPerson();
  if (!person) redirect("/entrar");

  return <DayScreen />;
}
