import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { z } from "zod";

import { DayScreen, oldestPastDay } from "@/components/day/day-screen";
import { getPerson } from "@/lib/session";
import { isCivilDate, todayInZone } from "@/lib/zone";

const fechaSchema = z.string().refine(isCivilDate);

// Static per route: no title reads the day (RNP-01).
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("day");
  return { title: t("pastTitle") };
}

// `DiaPasado.dc.html` (RP-06): a day already past, as its own screen. The
// same window `declareFact` enforces, so the route never draws a day whose
// rows could not be written: not a date or a day still to come is not found,
// one more than `PAST_DAY_LIMIT` back opens its week; today is `/` itself.
export default async function PastDayPage({ params }: { params: Promise<{ fecha: string }> }) {
  const person = await getPerson();
  if (!person) redirect("/entrar");

  const { fecha } = await params;
  const parsed = fechaSchema.safeParse(fecha);
  if (!parsed.success) notFound();

  const day = parsed.data;
  const today = todayInZone();
  if (day === today) redirect("/");
  if (day > today) notFound();
  // Past the window the day cannot be written, but its week can be read (RP-44).
  if (day < oldestPastDay(today)) redirect(`/semana?semana=${day}`);

  return <DayScreen day={day} />;
}
