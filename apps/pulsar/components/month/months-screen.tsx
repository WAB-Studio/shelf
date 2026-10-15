import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { BudgetSheet } from "@/components/month/budget-sheet";
import { MonthDetail } from "@/components/month/month-screen";
import { dayBefore } from "@/lib/day/weeks";
import { endlessCut, foldsMonths } from "@/lib/lists/endless-cut";
import { nextMonth, settledMonths } from "@/lib/plan/months";
import { planMonthList, planShare } from "@/lib/plan/roadmap-read";
import { screenPlanned } from "@/lib/plan/screen-planned";
import { loadGoal, type GoalView } from "@/lib/queries/goal";
import { formatQuantity, isTimeUnit } from "@/lib/units/time";
import { civilDayMonthYear } from "@/lib/zone";
import { timeWordsOf } from "@/lib/units/time-words";
import { Button, ListDetail, Page, ScreenHeader, Table, Text, TextLink, type TableRow } from "@/components/ui";

const monthFormat = new Intl.DateTimeFormat("es", { month: "long", timeZone: "UTC" });

// "2026-10-01" as «octubre».
function monthLabel(month: string): string {
  return monthFormat.format(new Date(`${month}T12:00:00Z`));
}

// «octubre 2026»: the row's own name, told apart from its namesake a year on.
function yearLabel(month: string): string {
  return `${monthLabel(month)} ${month.slice(0, 4)}`;
}

/**
 * `MesesFilas.dc.html` (RP-32): one whole-row link per month of the goal's
 * span from `loadGoal`'s own `months`, the month open beside the list marked.
 * The phone's stack is drawn at every width: the list lives in a 320px column
 * from 1024. A month's amount is set from its own page, never from the row.
 */
export async function MonthsList({
  goal: loaded,
  open,
  all = false,
  keep = "",
}: {
  goal: GoalView;
  open: string;
  // `?todo=1`: the whole span of a folded goal, closed months included.
  all?: boolean;
  // The query the link keeps (`planear`, `volver`), already encoded.
  keep?: string;
}) {
  const t = await getTranslations();
  const settled = settledMonths(loaded.months, loaded.endedOn !== null);
  const folds = foldsMonths(loaded.horizon, settled);
  const ends = loaded.horizon === null ? undefined : { lastDay: dayBefore(loaded.horizon) };
  // A goal with no end, or an end past 12 months, shows its months up to this one (last 12), the next and those ahead set by hand; the rest ahead fold into a line.
  // A month open outside the last 12 shows the whole list.
  const folded = folds ? endlessCut(settled, { all: false, rhythm: loaded.rhythm, ends }) : null;
  const openOutside = folded !== null && !folded.shown.some((row) => row.month === open);
  const cut = folds ? endlessCut(settled, { all: all || openOutside, rhythm: loaded.rhythm, ends }) : null;
  const goal = { ...loaded, months: cut ? cut.shown : settled };
  const allHref = `/metas/${goal.id}/meses?${keep ? `${keep}&` : ""}todo=1`;
  const seeAll = cut?.seeAll ? <TextLink href={allHref}>{t("common.seeAll")}</TextLink> : null;
  // Opened whole with `?todo=1`, a list that folds goes back to its fold: the same screen, `keep` intact.
  const seeLess =
    all && folded?.seeAll ? (
      <TextLink href={`/metas/${goal.id}/meses${keep ? `?${keep}` : ""}`}>{t("common.seeLess")}</TextLink>
    ) : null;
  // A folded list names the closed months it hides before its table; the line opens what «ver todo» opens.
  const earlier = cut && cut.hidden > 0 ? (
    <Text as="p" variant="line">
      <TextLink href={allHref}>{t("month.months.earlier", { count: cut.hidden })}</TextLink>
    </Text>
  ) : null;
  // A goal with an end counts the months after the last shown; the line names them and opens nothing.
  const rest = cut?.rest ? (
    <Text as="p" variant="line">
      {t("month.months.rest", { count: cut.rest.count, date: civilDayMonthYear(cut.rest.lastDay) })}
    </Text>
  ) : null;
  const sheetFor = (month: string) =>
    cut?.next?.month === month && Boolean(loaded.measureUnit) && !loaded.holdsGoals && loaded.archivedAt === null;
  const hrefOf = (month: string) =>
    sheetFor(month)
      ? `/metas/${goal.id}/meses?${keep ? `${keep}&` : ""}planear=${month.slice(0, 7)}`
      : `/metas/${goal.id}/meses/${month.slice(0, 7)}`;
  // A holder keeps no amount of its own (RP-80): its summed months stay in the first table, in order.
  const ownKeys = new Set(cut && !loaded.holdsGoals ? cut.handSet.map((row) => row.month) : []);
  // A goal with an end whose list folds says its rows out of its months.
  const caption =
    loaded.horizon !== null && goal.months.length < settled.length
      ? t("month.months.captionOf", { count: goal.months.length, total: settled.length })
      : t("month.months.caption", { count: goal.months.length });
  const currentIndex = goal.months.findIndex((row) => row.current);
  const openIndex = goal.months.findIndex((row) => row.month === open);
  // A holder measures through its goals: its own measure name may be empty (RP-80).
  if (!goal.measureUnit || (!goal.measureName && !goal.holdsGoals)) {
    const bare: TableRow[] = goal.months.map((row) => {
      const count = planMonthList(goal.plan, row.month).length;
      const tasks = (
        <Text tone="secondary">
          {count === 0
            ? t("month.months.withoutMeasure.none")
            : t("month.months.withoutMeasure.tasks", { count })}
        </Text>
      );
      return {
        key: row.month,
        href: hrefOf(row.month),
        cells: [yearLabel(row.month), tasks],
        detail: row.current ? t("month.months.current") : null,
        note: tasks,
      };
    });
    return (
      <>
        <Table
          narrow
          caption={caption}
          columns={[t("month.months.columns.month"), t("month.months.withoutMeasure.columnTasks")]}
          rows={bare}
          current={currentIndex === -1 ? undefined : currentIndex}
          open={openIndex === -1 ? undefined : openIndex}
          after={rest ?? undefined}
          above={seeLess ?? earlier}
        />
        {seeAll}
        {seeLess}
      </>
    );
  }

  const unit = goal.measureUnit;
  const timed = isTimeUnit(unit);
  const words = timeWordsOf(t as unknown as Parameters<typeof timeWordsOf>[0]);
  // The rhythm's line (no end) opens the whole list and comes before the months set by hand; `rest` closes the last table.
  const ahead = cut?.line || ownKeys.size > 0 ? (
    <>
      {cut?.line ? (
        <Text as="p" variant="line">
          <TextLink href={allHref}>{t("month.months.ahead", { planned: formatQuantity(cut.line.planned, unit, words) })}</TextLink>
        </Text>
      ) : null}
      {ownKeys.size > 0 ? (
        <Text as="p" variant="line">
          {cut?.line ? t("month.months.andOwn") : t("month.months.own")}
        </Text>
      ) : null}
    </>
  ) : null;

  const rows: TableRow[] = goal.months.map((row) => {
    const started = row.past || row.current;
    const share = row.past ? planShare(goal.plan, row.month) : null;
    const own = screenPlanned(row.planned, goal.plan.budgets.some((budget) => budget.month === row.month));
    const figure = own === null ? null : formatQuantity(own, unit, words);
    const said = figure === null ? t("month.months.noAmount") : started ? t("month.months.of", { planned: figure }) : figure;
    const amount = <Text tone="secondary">{said}</Text>;
    const state = row.current
      ? t("month.months.current")
      : share && share.carried > 0
        ? t("month.months.carriedTo", {
            percent: Math.floor((share.carried * 100) / share.planned),
            month: monthLabel(nextMonth(row.month)),
          })
        : own !== null && !started
          ? t("month.months.planned")
          : null;

    const count = timed && goal.plan.rhythm !== null ? 0 : planMonthList(goal.plan, row.month).length;
    const tasks = count === 0 ? null : t("month.months.tasksCount", { count });

    return {
      key: row.month,
      href: hrefOf(row.month),
      cells: [yearLabel(row.month), started ? row.reached : null, amount],
      // The state over the task count, never joined by a «·» that a narrow row would leave hanging.
      detail:
        state && tasks ? (
          <>
            {state}
            <br />
            {tasks}
          </>
        ) : (
          (state ?? tasks)
        ),
      note: amount,
    };
  });

  const firstRows = rows.filter((row) => !ownKeys.has(row.key));
  const ownRows = rows.filter((row) => ownKeys.has(row.key));
  return (
    <>
      <Table
        narrow
        // «0 de 60 búsquedas» may break before its unit; a time note («de 12 h», «sin monto») never splits and drops whole under its month when it does not fit.
        wrapNote={!timed}
        wholeNote={timed}
        caption={caption}
        columns={[
          t("month.months.columns.month"),
          t("month.months.columns.reached"),
          t("month.months.columns.planned"),
        ]}
        rows={firstRows}
        above={seeLess ?? earlier}
        figures={[1]}
        // A unit that is not time rides in each row's note («0 de 60 búsquedas»), once.
        unit={timed ? unit : undefined}
        current={currentIndex === -1 ? undefined : currentIndex}
        open={openIndex === -1 ? undefined : openIndex}
        after={
          ahead || (rest && ownRows.length === 0) ? (
            <>
              {ahead}
              {ownRows.length === 0 ? rest : null}
            </>
          ) : undefined
        }
      />
      {ownRows.length > 0 ? (
        <Table
          narrow
          wrapNote={!timed}
          wholeNote={timed}
          caption=""
          columns={[
            t("month.months.columns.month"),
            t("month.months.columns.reached"),
            t("month.months.columns.planned"),
          ]}
          rows={ownRows}
          figures={[1]}
          unit={timed ? unit : undefined}
          after={rest ?? undefined}
        />
      ) : null}
      {seeAll}
      {seeLess}
    </>
  );
}

/**
 * `MesesFilas.dc.html` / `MesesListaDetalle.dc.html` / `MesesVacio.dc.html` /
 * `MesesSinMedida.dc.html` (RP-28, RP-31, RP-32, RP-50): the goal's months, and
 * from 1024 the month beside them — the current one, or the first outside the
 * span. The amount of a month still to be planned opens the amount sheet
 * through `?planear=`; an ended or archived goal offers no sheet.
 */
export async function MonthsScreen({
  goalId,
  planning,
  returnPath,
  all = false,
  keep = "",
}: {
  goalId: string;
  planning: string | null;
  returnPath: string;
  all?: boolean;
  keep?: string;
}) {
  const loaded = await loadGoal(goalId);
  if (!loaded) notFound();
  const goal = { ...loaded, months: settledMonths(loaded.months, loaded.endedOn !== null) };

  const t = await getTranslations();
  const open = goal.archivedAt === null && goal.endedOn === null;
  // A goal with every month behind it opens on its last one, inside the folded list.
  const target =
    goal.months.find((row) => row.current) ?? (goal.months.every((row) => row.past) ? goal.months.at(-1) : goal.months[0]);
  const empty = !goal.holdsGoals && Boolean(goal.measureUnit && goal.measureName) && goal.budgets.length === 0 && goal.rhythm === null;
  const planHref = (month: string) => `/metas/${goal.id}/meses?planear=${month.slice(0, 7)}`;

  const unit = goal.measureUnit;
  const planned = open && unit && !goal.holdsGoals
    ? goal.months.find((row) => !row.past && row.month.slice(0, 7) === planning)
    : undefined;

  return (
    <Page width="full">
      <ScreenHeader
        chat
        title={t("month.months.title")}
        back={{ href: `/metas/${goal.id}`, place: goal.name }}
      />
      {goal.holdsGoals ? (
        <Text as="p" variant="sentence">
          {t("tree.holder.monthsSentence")}
        </Text>
      ) : null}
      {empty && open && target ? (
        <>
          <Text as="p" variant="sentence">
            {t("month.months.emptyBody", { month: monthLabel(target.month) })}
          </Text>
          <Button asChild>
            <Link href={planHref(target.month)}>
              {t("month.months.emptyAction", { month: monthLabel(target.month) })}
            </Link>
          </Button>
        </>
      ) : null}
      {target ? (
        <ListDetail
          show="list"
          list={<MonthsList goal={goal} open={target.month} all={all} keep={keep} />}
          detail={<MonthDetail
              goal={goal}
              month={target.month.slice(0, 7)}
              from={`/metas/${goal.id}/meses`}
              heading
            />}
        />
      ) : null}
      {planned && unit ? (
        <BudgetSheet
          key={planned.month}
          goalId={goal.id}
          goalName={goal.name}
          unit={unit}
          month={planned.month.slice(0, 7)}
          monthName={monthLabel(planned.month)}
          amount={planned.planned}
          stored={goal.budgets.some((budget) => budget.month.slice(0, 7) === planned.month.slice(0, 7))}
          closeHref={returnPath}
        />
      ) : null}
    </Page>
  );
}
