import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";

import { WeekScreen } from "@/components/week/week-screen";
import { parseWeekParam } from "@/lib/day/week-param";
import { getPerson } from "@/lib/session";
import { todayInZone } from "@/lib/zone";

const NO_LIMIT = "9999-12-27";

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
  // The limit comes with the read: `WeekScreen` sends a week past it back to this one.
  const week = parseWeekParam((await searchParams).semana, today, NO_LIMIT);
  if (week.kind === "redirect") redirect("/semana");

  return <WeekScreen day={week.kind === "past" || week.kind === "coming" ? week.monday : today} today={today} />;
}
