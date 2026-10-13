import { getTranslations } from "next-intl/server";

import { Page, ScreenHeader } from "@/components/ui";
import { dayWords } from "@/lib/day/day-words";
import { listDaylessOneOffs, listScheduledOneOffs } from "@/lib/queries/one-offs";
import { todayInZone } from "@/lib/zone";

import { WaitingList } from "./waiting-list";

/**
 * What waits (RP-59, `SueltasProgramadas.dc.html`): the one-offs with no day,
 * then those dated after today. Each can be done, moved or deleted from here.
 */
export async function DaylessScreen() {
  const t = await getTranslations();
  const today = todayInZone();
  const [dayless, scheduled] = await Promise.all([
    listDaylessOneOffs(),
    listScheduledOneOffs(today),
  ]);

  const weekdays = t.raw("day.weekdayLong") as string[];
  const months = t.raw("day.monthLong") as string[];
  const when = (day: string) => {
    const words = dayWords(day, today);
    const parts = {
      weekday: weekdays[words.weekday],
      day: words.day,
      month: words.month === null ? "" : months[words.month],
    };
    return t(words.month === null ? "oneOffs.when" : "oneOffs.whenFar", parts);
  };

  return (
    <Page width="column">
      <ScreenHeader
        chat
        title={t("oneOffs.title")}
        back={{ href: "/", place: t("common.nav.today") }}
      />
      <WaitingList
        dayless={dayless.map((oneOff) => ({
          id: oneOff.id,
          name: oneOff.name,
          goalName: oneOff.goalName ?? undefined,
          note: oneOff.note,
        }))}
        scheduled={scheduled.map((oneOff) => ({
          id: oneOff.id,
          name: oneOff.name,
          goalName: oneOff.goalName ?? undefined,
          note: oneOff.note,
          scheduled: { day: oneOff.day, label: when(oneOff.day) },
        }))}
      />
    </Page>
  );
}
