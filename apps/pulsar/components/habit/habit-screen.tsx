import { getTranslations } from "next-intl/server";

import { EditHabitAction } from "@/components/habit/habit-edit-sheet";
import { RetireAction } from "@/components/goal/retire-sheet";
import { Figure, Page, ScreenHeader, Section, Table, Text, TextLink, type TableRow } from "@/components/ui";
import { cadencePhrase } from "@/lib/day/row-phrases";
import { LIST_TAIL, tailOf } from "@/lib/lists/tail";
import type { HabitView } from "@/lib/queries/habit";
import { civilDayMonthYear } from "@/lib/zone";

/**
 * `HabitoPantalla` (RP-104, RP-105, RP-106): one loose habit, its months and
 * the two acts on it. A retired habit keeps its months and offers neither act.
 * `back` and `seeAllHref` arrive decided: the page owns the query string.
 */
export async function HabitScreen({
  habit,
  back,
  seeAllHref,
  seeLessHref,
  all,
}: {
  habit: HabitView;
  back: { href: string; place: string };
  seeAllHref: string;
  seeLessHref: string;
  all: boolean;
}) {
  const t = await getTranslations();
  const monthNames = t.raw("day.monthLong") as string[];
  const cadence =
    cadencePhrase((key, values) => t(key, values), habit.cadence, {
      weekdayShort: t.raw("day.cadence.weekdayName") as string[],
      weekdayPlural: t.raw("day.cadence.weekdayPlural") as string[],
    }) ?? t("day.cadence.everyDay");
  const retired = habit.retiredOn !== null;

  const { shown, hidden } = tailOf(habit.months, all);
  const seeLess =
    all && habit.months.length > LIST_TAIL ? <TextLink href={seeLessHref}>{t("common.seeLess")}</TextLink> : null;
  const rows: TableRow[] = shown.map((month) => {
    const line = month.weeks
      ? month.weeks.counted === 0
        ? t("habit.months.noWeeks")
        : t("habit.months.lineWeeks", month.weeks)
      : month.asked === null
        ? t("habit.months.line", { count: month.daysDone })
        : t("habit.months.lineOf", { done: month.daysDone, asked: month.asked });
    return {
      key: month.month,
      cells: [`${monthNames[Number(month.month.slice(5, 7)) - 1]} ${month.month.slice(0, 4)}`, line],
      detail: month.current ? t("habit.months.current") : null,
      note: month.thisWeek ? (
        <>
          {line}
          <br />
          {t("week.flexible.weekProgress", { done: month.thisWeek.done, total: month.thisWeek.count })}
        </>
      ) : line,
    };
  });
  const currentIndex = shown.findIndex((month) => month.current);

  return (
    <Page>
      <ScreenHeader
        title={habit.name}
        back={back}
        eyebrow={t("habit.overline", { date: civilDayMonthYear(habit.createdOn) })}
        metaVariant="sentence"
        meta={
          <>
            {cadence}
            {habit.satisfiedBy.kind === "quantity" ? (
              <>
                {" · "}
                <Figure value={habit.satisfiedBy.target} unit={habit.satisfiedBy.unit} variant="meta" />
              </>
            ) : null}
            {retired ? (
              <>
                <br />
                {t("habit.retiredOn", { date: civilDayMonthYear(habit.retiredOn!) })}
              </>
            ) : null}
          </>
        }
      />
      {habit.note ? (
        <Text as="p" variant="body" note>
          {habit.note}
        </Text>
      ) : null}
      {retired ? null : <EditHabitAction habitId={habit.id} name={habit.name} note={habit.note} />}
      <Section label={t("habit.months.title")}>
        <Table
          narrow
          above={seeLess}
          caption={t("habit.months.caption", { count: habit.months.length })}
          columns={[t("habit.months.columns.month"), t("habit.months.columns.days")]}
          rows={rows}
          current={currentIndex === -1 ? undefined : currentIndex}
        />
        {hidden > 0 ? <TextLink href={seeAllHref}>{t("habit.months.seeAll")}</TextLink> : null}
        {seeLess}
      </Section>
      {retired ? null : (
        <RetireAction
          label={t("habit.retire")}
          commitmentId={habit.id}
          name={habit.name}
          factDayCount={habit.factDayCount}
        />
      )}
    </Page>
  );
}
