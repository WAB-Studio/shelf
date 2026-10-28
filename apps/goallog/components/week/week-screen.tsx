import { ChevronLeft, ChevronRight } from "lucide-react";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { type Translator } from "@/i18n/translator";
import { Face, Flex, Page, ScreenHeader, Section, SectionLabel, Text, TextLink } from "@/components/ui";
import { endedOnPhrase } from "@/lib/day/day-phrase";
import { weekDayHref } from "@/lib/day/week-href";
import { daysBetween } from "@/lib/day/weeks";
import { weekSteps } from "@/lib/day/week-param";
import { listDaylessOneOffs, listGoalOneOffs } from "@/lib/queries/one-offs";
import { loadWeek, type GoalSummary } from "@/lib/queries/week";
import { civilDateToDate, weekOf } from "@/lib/zone";

import { EvidenceNote } from "@/components/day/evidence-note";
import { GiveDayList } from "@/components/one-offs/give-day-list";
import { GiveDayRow } from "@/components/one-offs/give-day-row";
import { EmptyWeek } from "./empty-week";
import { EndedLine } from "./ended-line";
import { endedLastDay } from "./week-progress";
import { WeekTableFace } from "./week-table-face";


// The day number alone when both ends of the range share a month
// (`Semana.dc.html`'s own "Del 21 al 27"), the month's short name added where
// a week crosses one: «Del 28 sep al 4 oct» (`SemanaPasadaEscritorio.dc.html`).
function formatRangeEnd(day: string, monthNames: string[], withMonth: boolean): string {
  const [, month, dayOfMonth] = day.split("-");
  const dayNumber = String(Number(dayOfMonth));
  return withMonth ? `${dayNumber} ${monthNames[Number(month) - 1]}` : dayNumber;
}

function formatWeekRange(start: string, end: string, t: Translator): string {
  const monthNames = t.raw("week.monthShort") as string[];
  const sameMonth = start.slice(0, 7) === end.slice(0, 7);
  const ends = {
    start: formatRangeEnd(start, monthNames, !sameMonth),
    end: formatRangeEnd(end, monthNames, !sameMonth),
  };
  if (!sameMonth) return t("week.range", ends);
  return t("week.rangeWithMonth", { ...ends, month: (t.raw("day.monthLong") as string[])[Number(end.slice(5, 7)) - 1] });
}

// The week's distance from today, said the way `SemanaPasada.dc.html` heads it.
function eyebrowFor(monday: string, thisMonday: string, firstMonday: string | null, t: Translator): string {
  const weeks = daysBetween(thisMonday, monday) / 7;
  if (weeks === 0) return t("week.eyebrow.this");
  if (weeks > 0) return weeks === 1 ? t("week.eyebrow.next") : t("week.eyebrow.ahead", { count: weeks });
  const month = (t.raw("day.monthLong") as string[])[Number(monday.slice(5, 7)) - 1];
  if (monday === firstMonday) return t("week.eyebrow.first", { month });
  return weeks === -1 ? t("week.eyebrow.last") : t("week.eyebrow.ago", { month, count: -weeks });
}

function stepHref(monday: string | null, thisMonday: string): string | null {
  if (monday === null) return null;
  return monday === thisMonday ? "/semana" : `/semana?semana=${monday}`;
}

/**
 * The Monday-to-Sunday week `day` sits in, read-only beyond seven days back.
 * ‹ › step a week at a time (`SemanaPasada.dc.html`); the week is drawn by
 * `WeekTableFace`, folded to one row per commitment on the phone.
 *
 * With no open goal at all (RP-11) `EmptyWeek` stands in for the range, in
 * the day screen's own words.
 */
export async function WeekScreen({ day, today }: { day: string; today: string }) {
  const t = await getTranslations();
  const thisMonday = weekOf(today)[0];
  const coming = weekOf(day)[0] > thisMonday;
  // A coming week also offers the tasks that wait with no day: read beside the week, never after it.
  const [week, goalDayless, looseDayless] = await Promise.all([
    loadWeek(day, today),
    coming ? listGoalOneOffs(today) : [],
    coming ? listDaylessOneOffs() : [],
  ]);
  const { view, evidence, goals } = week;
  // The page cannot know the limit before the read: a week past it leaves for this one.
  if (view.start > week.lastMonday) redirect("/semana");

  // A week before the first goal's has nothing to read: land on the first.
  if (week.firstMonday !== null && view.start < week.firstMonday) {
    redirect(stepHref(week.firstMonday, thisMonday) ?? "/semana");
  }
  const past = view.start < thisMonday;
  const steps = weekSteps({ monday: view.start, thisMonday, firstMonday: week.firstMonday, lastMonday: week.lastMonday });
  const prev = stepHref(steps.prev, thisMonday);
  const next = stepHref(steps.next, thisMonday);

  const weekdayNames = t.raw("week.weekdayShort") as string[];
  const weekdayLong = t.raw("week.weekdayLong") as string[];
  const columns = view.days.map((dayView) => {
    const href = weekDayHref(dayView.day, today);
    const weekday = (civilDateToDate(dayView.day).getUTCDay() + 6) % 7;
    const dayNumber = Number(dayView.day.slice(8, 10));
    const isToday = dayView.day === today;
    return {
      key: dayView.day,
      label: `${weekdayNames[weekday]} ${dayNumber}`,
      mark: isToday ? t("week.todayMark") : undefined,
      href: href ?? undefined,
      hrefLabel: href ? t("week.openDay", { weekday: weekdayLong[weekday], day: dayNumber }) : undefined,
      today: isToday,
    };
  });

  // «terminó el <día> · ver»: Hoy's own phrase and keys, always naming the day
  // since the week is not read from today.
  function endedNote(goal: GoalSummary) {
    const lastDay = endedLastDay(goal.horizon, today);
    if (lastDay === null) return null;
    const text = endedOnPhrase((key, values) => t(key, values), "", lastDay, {
      weekdays: t.raw("day.weekdayLong") as string[],
      months: t.raw("day.monthLong") as string[],
    });
    return (
      <EndedLine
        text={text.trim()}
        href={`/metas/${goal.id}`}
        see={t("day.ended.see")}
        seeLabel={t("day.ended.seeLabel", { goal: goal.name })}
      />
    );
  }

  function step(href: string | null, label: string, icon: "prev" | "next") {
    if (href === null) return <Flex flexGrow="1" aria-hidden />;
    return (
      <TextLink href={href} nowrap>
        <Flex as="span" align="center" gap="1">
          {icon === "prev" ? <ChevronLeft size={16} aria-hidden /> : null}
          {label}
          {icon === "next" ? <ChevronRight size={16} aria-hidden /> : null}
        </Flex>
      </TextLink>
    );
  }

  const eyebrow = eyebrowFor(view.start, thisMonday, week.firstMonday, t);
  const stepLinks = (
    <>
      {step(prev, t("week.nav.prev"), "prev")}
      {step(next, t("week.nav.next"), "next")}
    </>
  );

  return (
    <Page width="full">
      <ScreenHeader
        chat
        steps
        title={formatWeekRange(view.start, view.days[6]?.day ?? view.start, t)}
        eyebrowFill
        eyebrow={
          <>
            <Face on="phone">
              <Flex justify="between" align="center" gap="3" width="100%">
                {stepLinks}
              </Flex>
            </Face>
            <SectionLabel>{eyebrow}</SectionLabel>
          </>
        }
        actions={
          <Face on="desktop">
            <Flex align="center" justify="end" gap="5">
              {stepLinks}
            </Flex>
          </Face>
        }
      />

      {evidence === "unreadable" ? (
        <EvidenceNote title={t("week.unreadableTitle")} body={t("week.unreadableBody")} />
      ) : null}

      {goals.length === 0 && week.loose.commitments.length === 0 ? (
        // A coming week past every goal's end: a goal was opened, it asks nothing here.
        coming && week.firstMonday !== null ? (
          <Text as="p" variant="sentence">
            {t("week.coming.nothingAsked")}
          </Text>
        ) : (
          <EmptyWeek title={t("week.empty.title")} action={t("week.empty.action")} />
        )
      ) : null}

      <WeekTableFace week={week} today={today} past={past} coming={coming} columns={columns} t={t} endedNote={endedNote} />

      {coming ? (
        <>
          <Section as="div" label={t("week.coming.datedTitle")}>
            {week.tasks.length === 0 ? (
              <Text as="p" variant="sentence">
                {t("week.coming.noneDated")}
              </Text>
            ) : (
              week.tasks.map((task) => {
                const weekday = (civilDateToDate(task.day).getUTCDay() + 6) % 7;
                const label = t("week.coming.dayLabel", { weekday: weekdayLong[weekday], day: Number(task.day.slice(8, 10)) });
                return (
                  <GiveDayRow
                    key={task.id}
                    oneOffId={task.id}
                    name={task.name}
                    meta={task.goalName ? t("week.coming.datedMeta", { day: label, goal: task.goalName }) : label}
                    scheduled={{ day: task.day, label }}
                  />
                );
              })
            )}
          </Section>
          <GiveDayList
            // One its plan holds in a month waits in that plan.
            tasks={[...goalDayless.filter((task) => task.plannedMonth === null), ...looseDayless]}
            suggest={view.start}
          />
        </>
      ) : null}
    </Page>
  );
}
