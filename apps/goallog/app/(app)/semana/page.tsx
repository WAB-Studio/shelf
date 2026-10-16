import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";

import { WeekScreen } from "@/components/week/week-screen";
import { parseWeekParam } from "@/lib/day/week-param";
import { getPerson } from "@/lib/session";
import { todayInZone } from "@/lib/zone";

// Static per route: no title reads a goal or costs a statement (RNP-01).
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("common.titles");
  return { title: t("week") };
}

// Same gate `app/page.tsx` runs: `app/layout.tsx` enforces no session of its
// own, so every screen redirects for itself. `getPerson` is the verified JWT
// alone, zero round trips.
export default async function WeekPage({
  searchParams,
}: {
  searchParams: Promise<{ semana?: string | string[] }>;
}) {
  const person = await getPerson();
  if (!person) redirect("/entrar");

  const today = todayInZone();
  const week = parseWeekParam((await searchParams).semana, today);
  if (week.kind === "redirect") redirect("/semana");

  return <WeekScreen day={week.kind === "past" ? week.monday : today} today={today} />;
}
