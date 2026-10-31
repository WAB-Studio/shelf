import { DayView } from "@/components/screens/day-view";
import { civilDay } from "@/lib/zone";

// «Hoy» (RT-04): the day view of today.
export default function TodayPage() {
  return <DayView day={civilDay()} />;
}
