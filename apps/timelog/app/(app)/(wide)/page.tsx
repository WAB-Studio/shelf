import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { DayView } from "@/components/screens/day-view";
import { civilDay } from "@/lib/zone";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("time.nav");
  return { title: t("today") };
}

// «Hoy» (RT-04): the day view of today.
export default function TodayPage() {
  return <DayView day={civilDay()} />;
}
