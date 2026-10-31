import { notFound, redirect } from "next/navigation";

import { DayView } from "@/components/screens/day-view";
import { civilDay, isCivilDay } from "@/lib/zone";

// A past day (RT-11). Not a real day, or one not yet reached, is a 404; today lives at «/».
export default async function DayPage({ params }: { params: Promise<{ dia: string }> }) {
  const { dia } = await params;
  const today = civilDay();
  if (!isCivilDay(dia) || dia > today) notFound();
  if (dia === today) redirect("/");
  return <DayView day={dia} />;
}
