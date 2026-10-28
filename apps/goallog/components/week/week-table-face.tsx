import type { ReactNode } from "react";

import { type MessageKey, type Translator } from "@/i18n/translator";
import { Face, Figure, Flex, Mark, Panel, Section, Text, WeekFold, WeekTable } from "@/components/ui";
import type { WeekTableCell, WeekTableColumn } from "@/components/ui/week-table";
import { tallyDays } from "@/lib/day/tally";
import type { DaySlot } from "@/lib/day/types";
import type { GoalSummary, loadWeek } from "@/lib/queries/week";
import { civilDateInZone, civilDateToDate, civilDayMonthShort } from "@/lib/zone";

import { goalWeekProgress } from "./week-progress";
import { flexibleWords, type FlexibleKey } from "@/lib/day/row-phrases";

type Week = Awaited<ReturnType<typeof loadWeek>>;

const PAST_KEY: Partial<Record<FlexibleKey, MessageKey>> = {
  "week.flexible.weekProgress": "week.flexible.weekProgressPast",
  "week.flexible.monthProgress": "week.flexible.monthProgressPast",
};

/**
 * `SemanaEscritorio.dc.html` from 1024, `SemanaPlegada.dc.html` below it: the
 * week as commitments down and days across, one set of groups drawn twice.
 * A day on or after a goal's horizon asks nothing of it, and neither does a
 * day before its commitment was written; each such day reads «no pedía».
 * `past` is a week already over: its counts say «esa semana». A week not yet begun counts nothing:
 * a flexible row says its cadence alone and no «hechos» row is drawn.
 */
// «13 sep 2026»: the year always, even in this one.
function archivedDay(instant: string): string {
  const day = civilDateInZone(new Date(instant));
  return `${civilDayMonthShort(day)} ${day.slice(0, 4)}`;
}

export function WeekTableFace({
  week,
  today,
  past,
  columns,
  t,
  endedNote,
}: {
  week: Week;
  today: string;
  past: boolean;
  columns: readonly WeekTableColumn[];
  t: Translator;
  endedNote: (goal: GoalSummary) => ReactNode;
}) {
  const { view, goals, commitments, oneOffFacts } = week;
  const coming = view.start > today;
  const weekdayLong = t.raw("week.weekdayLong") as string[];
  const horizonOf = new Map(goals.map((goal) => [goal.id, goal.horizon]));
  // A goal with no end has a null horizon: every day from its opening is live.
  const live = (goalId: string | null, day: string) => {
    const horizon = goalId === null ? null : horizonOf.get(goalId);
    return horizon == null || day < horizon;
  };

  function mark(
    name: string,
    day: string,
    status: "done" | "missed" | "upcoming" | "none" | "evidence" | "partial",
  ): WeekTableCell {
    return {
      state:
        status === "none"
          ? "none"
          : status === "evidence"
            ? "evidence"
            : status === "partial"
              ? "partial"
              : status === "done"
                ? "declared"
                : "empty",
      label: t("week.mark.label", {
        name,
        weekday: weekdayLong[(civilDateToDate(day).getUTCDay() + 6) % 7],
        day: Number(day.slice(8, 10)),
        status: t(`week.mark.${status}`),
      }),
    };
  }

  function slotStatus(slot: DaySlot, day: string) {
    if (day > today) return "upcoming";
    if (slot.satisfiedBy === "evidence") return "evidence";
    if (slot.partial) return "partial";
    return slot.satisfied ? "done" : "missed";
  }

  // The week's own counts say «esa semana» once it is over.
  const say = (key: FlexibleKey, values?: Record<string, number | string>) =>
    t(past ? (PAST_KEY[key] ?? key) : key, values);

  const commitmentRows = (goalId: string | null) =>
    commitments
      .filter((commitment) => commitment.goalId === goalId)
      .map((commitment) => {
        const words = flexibleWords(commitment, say);
        return {
          key: commitment.id,
          name: commitment.name,
          detail: words ? (coming ? words.cadence : t("week.flexible.detail", words)) : undefined,
          cells: view.days.map((dayView) => {
            const slot = dayView.slots.find((s) => s.commitmentId === commitment.id);
            // A flexible row marks the days it was done or logged in part and
            // leaves the rest quiet: no day of it was ever asked on its own.
            if (!live(goalId, dayView.day) || !slot || (words && !slot.satisfied && !slot.partial)) {
              return mark(commitment.name, dayView.day, "none");
            }
            return mark(commitment.name, dayView.day, slotStatus(slot, dayView.day));
          }),
        };
      });

  const oneOffRows = (goalId: string | null) =>
    oneOffFacts
      .filter((fact) => fact.goalId === goalId)
      .map((fact) => ({
        key: fact.oneOffId,
        name: fact.name,
        detail: fact.parentName ? t("day.monthLine.parent", { name: fact.parentName }) : undefined,
        sentence: true,
        cells: view.days.map((dayView) =>
          mark(fact.name, dayView.day, dayView.day === fact.day && live(goalId, dayView.day) ? "done" : "none"),
        ),
      }));

  const goalGroups = goals.map((goal) => {
    const progress = goalWeekProgress(goal, view.start);
    const label = progress
      ? t("week.sectionLabel", { name: goal.name, week: progress.week, total: progress.total })
      : goal.name;
    return {
      key: goal.id,
      // An archive since keeps the weeks the goal governed (RP-24).
      label: goal.archivedAt
        ? t("week.archivedOn", { label, date: archivedDay(goal.archivedAt) })
        : label,
      note: past ? null : endedNote(goal),
      rows: [...commitmentRows(goal.id), ...oneOffRows(goal.id)],
    };
  });
  const habitRows = commitmentRows(null);
  const looseRows = oneOffRows(null);
  const foldGroups = [
    ...goalGroups,
    ...(habitRows.length > 0 ? [{ key: "habits", label: t("week.habits.title"), rows: habitRows }] : []),
    ...(looseRows.length > 0 ? [{ key: "one-offs", label: t("week.oneOffs.title"), rows: looseRows }] : []),
  ];
  // Neither face heads a goal with nothing to mark; an ended note keeps its group.
  const tableGroups = foldGroups.filter((group) => group.rows.length > 0);
  const phoneGroups = foldGroups.filter((group) => group.rows.length > 0 || ("note" in group && group.note));

  if (foldGroups.length === 0) return null;

  const cells = tallyDays(week).map(({ day, done, total }) =>
    day > today || total === 0 ? null : { figure: String(done), rest: t("week.ratioOf", { total }) },
  );
  // A week with no day lived yet has nothing to tally.
  const footer = cells.some((cell) => cell !== null) ? { label: t("week.table.footer"), cells } : undefined;

  // `SemanaEnParte.dc.html`: the phone footer carries the partial days, over
  // the days that have come. Without one the per-day tally says it all.
  const lived = tallyDays(week).filter(({ day, total }) => day <= today && total > 0);
  const sum = (pick: (tally: (typeof lived)[number]) => number) => lived.reduce((acc, tally) => acc + pick(tally), 0);
  const partial = sum((tally) => tally.partial);
  const phoneFooter =
    footer && partial > 0
      ? {
          ...footer,
          label: t.rich("week.table.footerPartial", {
            done: sum((tally) => tally.done),
            total: sum((tally) => tally.total),
            partial,
            fig: (chunks) => <Figure variant="meta" value={chunks} />,
          }),
        }
      : footer;
  // The key shows whenever any half dot is drawn, flexible rows included.
  const halfDrawn = foldGroups.some((group) =>
    group.rows.some((row) => row.cells.some((cell) => cell.state === "partial")),
  );

  return (
    <>
      {tableGroups.length > 0 ? (
        <Face on="desktop">
          <Panel as="div">
            <WeekTable caption={t("week.table.caption")} columns={columns} groups={tableGroups} footer={footer} />
          </Panel>
        </Face>
      ) : null}
      <Face on="phone">
        <Section as="div">
          <WeekFold columns={columns} groups={phoneGroups} footer={phoneFooter} />
          {halfDrawn ? (
            <>
              <Flex wrap="wrap" gap="3" data-testid="week-legend">
                {(
                  [
                    ["declared", "week.legend.done"],
                    ["evidence", "week.legend.evidence"],
                    ["partial", "week.legend.partial"],
                    ["empty", "week.legend.pending"],
                  ] as const
                ).map(([state, key]) => (
                  <Flex key={state} align="center" gap="2">
                    <Mark state={state} size="dot" />
                    <Text variant="sentence">{t(key)}</Text>
                  </Flex>
                ))}
              </Flex>
            </>
          ) : null}
        </Section>
      </Face>
    </>
  );
}
