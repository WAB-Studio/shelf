import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { getTranslations } from "next-intl/server";

import { TaskRow, type TaskRowProps } from "@/components/month/task-row";
import { Flex, Progress, Row, Section, Text } from "@/components/ui";
import { Figure } from "@/components/ui/figure";
import { monthName } from "@/lib/plan/month-name";
import { monthOf } from "@/lib/plan/months";
import type { PlanItem, PlanMonth } from "@/lib/plan/roadmap";
import { doneIn, openMonthsOf, planMonthList, planMonthOf } from "@/lib/plan/roadmap-read";
import type { GoalView } from "@/lib/queries/goal";
import { formatQuantity, type TimeWords } from "@/lib/units/time";
import { todayInZone } from "@/lib/zone";

// Months drawn whole before the rest collapse: this one and the next.
const WHOLE = 2;

/**
 * `RoadmapPlan`'s month sections (RP-50, RP-54) and `RoadmapPasaElFinal`'s
 * «después de tu final». A task past the goal's end is listed there once, never
 * again in the month holding its hours.
 */
export async function PlanMonths({ goal, all }: { goal: GoalView; all: boolean }) {
  const t = await getTranslations();
  const units = await getTranslations("units");
  const words: TimeWords = {
    h: (h) => units("h", { h }),
    min: (min) => units("min", { min }),
    join: (h, min) => units("join", { h, min }),
  };
  const unit = goal.measureUnit;
  const say = (n: number) => (unit ? formatQuantity(n, unit, words) : String(n));
  // A section header's figure stays with its unit: a non-breaking space in plain text.
  const glue = (text: string) => text.replace(/ /g, "\u00a0");
  const thisYear = todayInZone().slice(0, 4);
  const { roadmap } = goal;
  // A goal with no end has no month past it.
  const lastMonth = roadmap.lastDay === null ? "9999-12-01" : monthOf(roadmap.lastDay);

  // A past-end task keeps the parts that fall inside the span in their month; only what
  // falls after the end is listed under «después de tu final», once per task.
  const pastEnd = new Map<string, PlanItem & { month: string }>();
  for (const month of roadmap.months) {
    if (month.month <= lastMonth) continue;
    for (const item of month.items) {
      if (!item.pastEnd) continue;
      const seen = pastEnd.get(item.task.id);
      pastEnd.set(
        item.task.id,
        seen ? { ...seen, part: seen.part + item.part } : { ...item, month: month.month, from: null, to: null },
      );
    }
  }
  const months = roadmap.months
    .map((month) => ({
      ...month,
      items: month.items.filter((item) => !item.pastEnd || month.month <= lastMonth),
    }))
    .filter((month) => month.items.length > 0 || month.month <= lastMonth);

  const openMonths = openMonthsOf(goal.plan);
  const pinned = goal.rhythm !== null;

  function trailingOf(own: PlanItem["task"], kids: PlanItem["children"], part: number) {
    if (!unit) return undefined;
    if (part > 0) return say(part);
    if (own.estimate === null && kids.length === 0) return t("roadmap.plan.unestimated");
    return own.parentId !== null && own.estimate ? say(own.estimate) : undefined;
  }

  function rowOf(item: PlanItem, month: string) {
    const { task, children } = item;
    const parent = children.length > 0;
    const split = item.from !== null || item.to !== null;
    const planMonth =
      item.fixed || item.from !== null
        ? (planMonthOf(goal.plan, task.id)?.slice(0, 7) ?? null)
        : month.slice(0, 7);
    const sheetOf = (own: typeof task, kids: typeof children): TaskRowProps["sheet"] => ({
      goalId: goal.id,
      goalName: goal.name,
      unit,
      estimate: own.estimate,
      planMonth,
      months: own.parentId === null ? openMonths : [],
      canDelete: own.doneOn === null && kids.every((kid) => kid.doneOn === null),
      fixedMonth: own.plannedMonth?.slice(0, 7) ?? null,
    });
    return (
      <Flex key={task.id} direction="column">
        <TaskRow
          oneOffId={task.id}
          name={task.name}
          factId={task.factId ?? null}
          done={item.done}
          parent={parent}
          meta={item.carriedFrom !== null ? t("month.list.fromMonth", { month: monthName(item.carriedFrom, thisYear) }) : undefined}
          trailing={trailingOf(task, children, item.part)}
          note={task.note}
          part={split ? { part: item.part, hours: item.hours, from: item.from, to: item.to } : undefined}
          fixedMonth={pinned ? task.plannedMonth?.slice(0, 7) : undefined}
          sheet={sheetOf(task, children)}
        />
        {children.map((child) => (
          <TaskRow
            key={child.id}
            oneOffId={child.id}
            name={child.name}
            factId={child.factId ?? null}
            done={child.doneOn !== null}
            child
            trailing={trailingOf(child, [], 0)}
            note={child.note}
            sheet={sheetOf(child, [])}
          />
        ))}
      </Flex>
    );
  }

  const fig = { fig: (chunks: ReactNode) => <Figure variant="meta" value={chunks} /> };
  // The current month counts what is done in it; a later one what the plan fills.
  function figureOf(month: PlanMonth, current: boolean) {
    if (!unit || month.amount === null) return null;
    return current
      ? t.rich("roadmap.plan.monthDone", {
          done: planMonthList(goal.plan, month.month).filter((item) => item.done).length,
          total: planMonthList(goal.plan, month.month).length,
          ...fig,
        })
      : t.rich("roadmap.plan.monthPlanned", { filled: say(month.filled), amount: say(month.amount), ...fig });
  }

  function percentOf(month: PlanMonth, current: boolean): number | null {
    if (!unit || month.amount === null || month.amount <= 0) return null;
    const count = current ? doneIn(goal.plan, month.month) : month.filled;
    return Math.floor((count * 100) / month.amount);
  }

  const whole = all ? months : months.slice(0, WHOLE);
  const rest = all ? [] : months.slice(WHOLE);
  const restItems = new Map<string, PlanItem>();
  for (const month of rest) for (const item of month.items) restItems.set(item.task.id, item);
  const restHours = rest.reduce((total, month) => total + month.items.reduce((sum, item) => sum + item.part, 0), 0);
  const pastItems = [...pastEnd.values()];
  const pastHours = pastItems.reduce((total, item) => total + item.part, 0);

  return (
    <>
      {whole.map((month) => {
        const current = monthOf(goal.plan.today) === month.month;
        const figure = figureOf(month, current);
        const percent = percentOf(month, current);
        const label = current
          ? t("roadmap.plan.currentMonth", { month: monthName(month.month, thisYear) })
          : monthName(month.month, thisYear);
        return (
          <Section
            key={month.month}
            label={
              <Flex justify="between" gap="3">
                <span>{label}</span>
                {figure ? <Text variant="sentence">{figure}</Text> : null}
              </Flex>
            }
          >
            {percent !== null ? <Progress percent={percent} size="thick" /> : null}
            <Flex direction="column">{month.items.map((item) => rowOf(item, month.month))}</Flex>
          </Section>
        );
      })}
      {rest.length > 0 ? (
        <Section
          label={
            <Flex justify="between" gap="3">
              <span>
                {rest.length > 1
                  ? t("roadmap.plan.range", {
                      from: monthName(rest[0].month, thisYear),
                      to: monthName(rest[rest.length - 1].month, thisYear),
                    })
                  : monthName(rest[0].month, thisYear)}
              </span>
              <span>{t("roadmap.plan.summary", { count: restItems.size, hours: glue(say(restHours)) })}</span>
            </Flex>
          }
        >
          <Row
            card
            href={`/metas/${goal.id}/plan?todo=1`}
            name={t("roadmap.plan.seeRest")}
            trailing={<ChevronRight size={20} aria-hidden />}
            rule={false}
          />
        </Section>
      ) : null}
      {pastItems.length > 0 ? (
        <Section
          label={
            <Flex justify="between" gap="3">
              <span>{t("roadmap.pasaElFinal.afterEnd")}</span>
              <span>{t("roadmap.pasaElFinal.summary", { count: pastItems.length, hours: glue(say(pastHours)) })}</span>
            </Flex>
          }
        >
          <Flex direction="column">{pastItems.map((item) => rowOf(item, item.month))}</Flex>
        </Section>
      ) : null}
    </>
  );
}
