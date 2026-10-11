import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { BudgetSheet } from "@/components/month/budget-sheet";
import { MonthDetail } from "@/components/month/month-screen";
import { amountOf } from "@/lib/plan/roadmap";
import { nextMonth } from "@/lib/plan/months";
import { monthDetail } from "@/lib/plan/month-detail";
import { planMonthList, planShare } from "@/lib/plan/roadmap-read";
import { loadGoal, type GoalView } from "@/lib/queries/goal";
import { formatQuantity, isTimeUnit, type TimeWords } from "@/lib/units/time";
import { Button, ListDetail, Page, ScreenHeader, Table, Text, type TableRow } from "@/components/ui";

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
export async function MonthsList({ goal, open }: { goal: GoalView; open: string }) {
  const t = await getTranslations();
  const hrefOf = (month: string) => `/metas/${goal.id}/meses/${month.slice(0, 7)}`;
  const caption = t("month.months.caption", { count: goal.months.length });
  const currentIndex = goal.months.findIndex((row) => row.current);
  const openIndex = goal.months.findIndex((row) => row.month === open);

  if (!goal.measureUnit || !goal.measureName) {
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
      <Table
        narrow
        caption={caption}
        columns={[t("month.months.columns.month"), t("month.months.withoutMeasure.columnTasks")]}
        rows={bare}
        current={currentIndex === -1 ? undefined : currentIndex}
        open={openIndex === -1 ? undefined : openIndex}
      />
    );
  }

  const unit = goal.measureUnit;
  const timed = isTimeUnit(unit);
  const units = await getTranslations("units");
  const words: TimeWords = {
    h: (h) => units("h", { h }),
    min: (min) => units("min", { min }),
    join: (h, min) => units("join", { h, min }),
  };

  const rows: TableRow[] = goal.months.map((row) => {
    const started = row.past || row.current;
    const share = row.past ? planShare(goal.plan, row.month) : null;
    const own = amountOf(row.month, goal.plan);
    const figure = own === null ? null : formatQuantity(own, unit, words);
    const amount = (
      <Text tone="secondary">
        {figure === null
          ? t("month.months.noAmount")
          : started
            ? t("month.months.of", { planned: figure })
            : figure}
      </Text>
    );
    const state = row.current
      ? t("month.months.current")
      : share && share.carried > 0
        ? t("month.months.carriedTo", {
            percent: Math.floor((share.carried * 100) / share.planned),
            month: monthLabel(nextMonth(row.month)),
          })
        : row.planned !== null && !started
          ? t("month.months.planned")
          : null;

    const count = timed ? 0 : planMonthList(goal.plan, row.month).length;
    const tasks = count === 0 ? null : t("month.months.tasksCount", { count });

    return {
      key: row.month,
      href: hrefOf(row.month),
      cells: [yearLabel(row.month), started ? row.reached : null, amount],
      detail: monthDetail(state, tasks),
      note: amount,
    };
  });

  return (
    <Table
      narrow
      caption={caption}
      columns={[
        t("month.months.columns.month"),
        t("month.months.columns.reached"),
        t("month.months.columns.planned"),
      ]}
      rows={rows}
      figures={[1]}
      unit={unit}
      current={currentIndex === -1 ? undefined : currentIndex}
      open={openIndex === -1 ? undefined : openIndex}
    />
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
}: {
  goalId: string;
  planning: string | null;
  returnPath: string;
}) {
  const goal = await loadGoal(goalId);
  if (!goal) notFound();

  const t = await getTranslations();
  const open = goal.archivedAt === null && goal.endedOn === null;
  const target = goal.months.find((row) => row.current) ?? goal.months[0];
  const empty = Boolean(goal.measureUnit && goal.measureName) && goal.budgets.length === 0;
  const planHref = (month: string) => `/metas/${goal.id}/meses?planear=${month.slice(0, 7)}`;

  const unit = goal.measureUnit;
  const planned = open && unit
    ? goal.months.find((row) => !row.past && row.month.slice(0, 7) === planning)
    : undefined;

  return (
    <Page width="full">
      <ScreenHeader
        title={t("month.months.title")}
        back={{ href: `/metas/${goal.id}`, place: goal.name }}
      />
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
          list={<MonthsList goal={goal} open={target.month} />}
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
          closeHref={returnPath}
        />
      ) : null}
    </Page>
  );
}
