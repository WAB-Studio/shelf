import type { ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { TaskRow } from "@/components/month/task-row";
import { MonthsList } from "@/components/month/months-screen";
import { Button, Flex, Figure, ListDetail, Mark, Page, ScreenHeader, Section, Separator, Text, TextLink } from "@/components/ui";
import type { Task } from "@/lib/plan/carry";
import type { PlanItem } from "@/lib/plan/roadmap";
import { closedMonthMarkDay } from "@/lib/plan/closed-month-marks";
import { nextMonth, partOf, partWords, settledMonths } from "@/lib/plan/months";
import { planHrefFrom } from "@/lib/plan/return-to";
import { openMonthsOf, planMonthList, planMonthOf, planShare } from "@/lib/plan/roadmap-read";
import { screenPlanned } from "@/lib/plan/screen-planned";
import { loadGoal, type GoalView } from "@/lib/queries/goal";
import { formatQuantity, isTimeUnit } from "@/lib/units/time";
import { timeWordsOf } from "@/lib/units/time-words";
import { todayInZone } from "@/lib/zone";

const monthFormat = new Intl.DateTimeFormat("es", { month: "long", timeZone: "UTC" });

function monthLabel(month: string): string {
  return monthFormat.format(new Date(`${month.slice(0, 7)}-01T12:00:00Z`));
}

function yearLabel(month: string): string {
  return `${monthLabel(month)} ${month.slice(0, 4)}`;
}

function capitalised(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function sum(tasks: Task[], pick: (task: Task) => number): number {
  return tasks.reduce((total, task) => total + pick(task), 0);
}

/** The dashed-circle link that closes a list: «Otra tarea», or, indented as the children, «Otra sub-tarea». */
function AddRow({ href, label, child }: { href: string; label: string; child?: boolean }) {
  return (
    <Flex asChild align="center" gap="3" minHeight="48px" ml={child ? "30px" : undefined}>
      <Text asChild tone="accent">
        <Link href={href}>
          <Mark state="empty" dashed />
          {label}
        </Link>
      </Text>
    </Flex>
  );
}

/**
 * `Mes`, `MesArrastre`, `MesVacio`, `MesCerrado`, `RoadmapTramoMedio` (RP-30,
 * RP-31, RP-32, RP-54): the month's own content, as the goal's plan places it
 * (`planMonthList`, carried ones first) and the closed month's share from
 * `planShare`.
 * `heading` draws the month's name as an `h2`, for the screen whose `h1` is
 * the list's title (`MesesListaDetalle.dc.html`).
 */
export async function MonthDetail({
  goal,
  month,
  from,
  heading,
}: {
  goal: GoalView;
  month: string;
  // The path the sheet returns to; the month page itself by default.
  from?: string;
  heading?: boolean;
}) {
  const mes = `${month}-01`;
  const row = goal.months.find((entry) => entry.month === mes);
  if (!row) notFound();

  const t = await getTranslations();
  const words = timeWordsOf(t as unknown as Parameters<typeof timeWordsOf>[0]);
  const name = monthLabel(mes);
  const unit = goal.measureUnit;
  const say = (n: number) => (unit ? formatQuantity(n, unit, words) : String(n));
  // The `<fig>` tags of the month catalogue: each figure of a mixed line in mono.
  const fig = { fig: (chunks: ReactNode) => <Figure variant="meta" value={chunks} /> };
  const open = goal.archivedAt === null && goal.endedOn === null;
  const closed = row.past;
  const markDay = closed ? closedMonthMarkDay(month, todayInZone()) : undefined;
  const rowPlanned = screenPlanned(row.planned, goal.plan.budgets.some((budget) => budget.month === mes));
  const noteEyebrow = t("oneOffs.note.eyebrowFull", { goal: goal.name, month: name });
  const addHref = `/metas/${goal.id}/meses/${month}/tarea/nueva`;

  const items = planMonthList(goal.plan, mes);
  const carried = items.filter((item) => item.carriedFrom !== null);
  const own = items.filter((item) => item.carriedFrom === null);
  const part = partOf(mes, goal.plan);
  const share = closed ? planShare(goal.plan, mes) : null;

  // A month that has not begun has nothing reached to show beside its amount:
  // «planeado» and the amount alone, or «sin monto planeado» alone.
  const bareFuture = !closed && !row.current;
  const planned =
    rowPlanned === null
      ? t("month.noPlan")
      : bareFuture
        ? say(rowPlanned)
        : t("month.months.of", { planned: say(rowPlanned) });
  const label = closed ? t("month.list.closed") : row.current ? t("month.list.thisMonth") : t("month.months.planned");
  let note: ReactNode = null;
  if (closed) {
    note = share && share.carried > 0
      ? t.rich("month.list.closedLineTo", {
          next: monthLabel(nextMonth(mes)),
          share: Math.floor((share.carried * 100) / share.planned),
          owed: say(share.carried),
          planned: say(share.planned),
          ...fig,
        })
      : null;
  }

  // A unit other than time has no plan: a month without an amount of its own takes the rhythm (RP-101).
  const rhythmTaken =
    unit !== null &&
    !isTimeUnit(unit) &&
    !goal.holdsGoals &&
    goal.rhythm !== null &&
    rowPlanned !== null &&
    !goal.plan.budgets.some((budget) => budget.month === mes);

  const openMonths = openMonthsOf(goal.plan);
  const sheetOf = (task: Task, kids: Task[]) => ({
    goalId: goal.id,
    goalName: goal.name,
    unit,
    estimate: task.estimate,
    planMonth: goal.roadmap.state === "planned" ? (planMonthOf(goal.plan, task.id)?.slice(0, 7) ?? null) : null,
    months: task.parentId === null ? openMonths : [],
    canDelete: task.doneOn === null && kids.every((kid) => kid.doneOn === null),
    fixedMonth: task.plannedMonth?.slice(0, 7) ?? null,
  });
  // A pin means something only against a plan.
  const pinOf = (task: Task) => (goal.rhythm !== null ? task.plannedMonth?.slice(0, 7) : undefined);

  function item(entry: PlanItem) {
    const { task, children } = entry;
    const childTotal = sum(children, (child) => child.estimate ?? 0);
    const childDone = sum(
      children.filter((child) => child.doneOn !== null),
      (child) => child.estimate ?? 0,
    );
    const isParent = children.length > 0;
    const owes = entry.carriedFrom !== null ? entry.part : isParent ? childTotal : (task.estimate ?? 0);

    const hasAmount = isParent ? children.some((child) => child.estimate !== null) : task.estimate !== null;
    let meta: ReactNode;
    if (entry.carriedFrom !== null) {
      meta = hasAmount
        ? t.rich("month.list.owes", { month: monthLabel(entry.carriedFrom), owes: say(entry.part), ...fig })
        : t("month.list.fromMonth", { month: monthLabel(entry.carriedFrom) });
    } else if (isParent) {
      meta = childTotal > 0 ? t.rich("month.list.doneOf", { done: say(childDone), total: say(childTotal), ...fig }) : undefined;
    } else if (closed && !entry.done) {
      meta = t("month.list.staysIn", { month: monthLabel(nextMonth(mes)) });
    }

    // The form's own rule (`tarea/nueva/page.tsx`): an open month's own parent, no day, no time, nothing done.
    const subtaskable =
      open &&
      !closed &&
      entry.carriedFrom === null &&
      task.parentId === null &&
      task.plannedMonth?.slice(0, 7) === month &&
      task.day === null &&
      task.estimate === null &&
      task.doneOn === null;

    return (
      <Flex key={task.id} direction="column">
        <TaskRow
          oneOffId={task.id}
          name={task.name}
          factId={task.factId ?? null}
          done={entry.done}
          parent={isParent}
          meta={meta}
          trailing={unit && owes > 0 ? say(owes) : undefined}
          note={task.note}
          noteEyebrow={noteEyebrow}
          part={
            entry.from !== null || entry.to !== null
              ? {
                  part: entry.part,
                  hours: entry.hours,
                  from: entry.from?.slice(0, 7) ?? null,
                  to: entry.to?.slice(0, 7) ?? null,
                }
              : undefined
          }
          fixedMonth={pinOf(task)}
          markDay={markDay}
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
            trailing={unit && child.estimate ? say(child.estimate) : undefined}
            note={child.note}
            noteEyebrow={noteEyebrow}
            markDay={markDay}
            sheet={sheetOf(child, [])}
          />
        ))}
        {subtaskable ? (
          <AddRow child href={`${addHref}?padre=${task.id}`} label={t("month.list.addSubtask")} />
        ) : null}
      </Flex>
    );
  }

  const carriedMonths = [...new Set(carried.map((entry) => entry.carriedFrom as string))];
  const ownPlanned = own.reduce((total, entry) => total + entry.part, 0);
  const empty = items.length === 0;

  return (
    <Flex direction="column" gap={{ initial: "6", md: "7" }} maxWidth="720px">
      {heading ? (
        <Text asChild variant="title">
          <h2>{capitalised(yearLabel(mes))}</h2>
        </Text>
      ) : null}
      {unit ? (
        <Section label={bareFuture && rowPlanned === null ? undefined : label} as="div">
          <Flex align="baseline" gap="2">
            {bareFuture ? null : <Figure value={row.reached} unit={unit} bare={rowPlanned !== null} />}
            {open && !closed && !goal.holdsGoals ? (
              <TextLink href={planHrefFrom(goal.id, month, from ?? `/metas/${goal.id}/meses/${month}`)}>
                {planned}
              </TextLink>
            ) : (
              <Text tone="secondary">{planned}</Text>
            )}
          </Flex>
          {part ? (
            <Text as="p" variant="sentence" tone="muted">
              {t.rich("goal.detail.monthPart", { ...partWords(part, mes, unit ?? "", say), ...fig })}
            </Text>
          ) : null}
          {rhythmTaken ? (
            <>
              <Text as="p" variant="sentence" tone="muted">
                {t("month.list.rhythmTaken", { amount: say(goal.rhythm as number) })}
              </Text>
              {open && !closed ? (
                <Button asChild variant="outline">
                  <Link href={planHrefFrom(goal.id, month, from ?? `/metas/${goal.id}/meses/${month}`)}>
                    {t("month.planMonth", { month: name })}
                  </Link>
                </Button>
              ) : null}
            </>
          ) : null}
          {note ? (
            <Text as="p" variant="sentence">
              {note}
            </Text>
          ) : null}
        </Section>
      ) : (
        <Text as="p" variant="sentence">
          {t("month.list.noMeasure")}
        </Text>
      )}
      <Separator />

      {carriedMonths.map((from) => (
        <Section key={from} as="div" label={t("month.list.fromMonth", { month: monthLabel(from) })}>
          {carried.filter((entry) => entry.carriedFrom === from).map(item)}
        </Section>
      ))}

      {empty && open && !closed ? (
        <Section as="div" label={t("month.list.tasks")}>
          <Text as="p" variant="sentence">
            {t(
              isTimeUnit(unit) ? "month.list.empty" : row.current ? "month.list.emptyNoMeasure" : "month.list.emptyNoMeasureLater",
              { month: capitalised(name), name },
            )}
          </Text>
          <Button asChild block>
            <Link href={addHref}>{t("month.list.emptyAction")}</Link>
          </Button>
        </Section>
      ) : null}

      {own.length > 0 ? (
        <Section
          as="div"
          label={
            closed || !unit || ownPlanned === 0
              ? t("month.list.tasks")
              : carried.length > 0
                ? t("month.list.ownMonth", { month: name, planned: say(ownPlanned) })
                : t("month.list.tasksPlanned", { planned: say(ownPlanned) })
          }
        >
          {own.map(item)}
        </Section>
      ) : null}

      {open && !closed && !empty ? (
        <AddRow href={addHref} label={t("month.list.addTask", { month: name })} />
      ) : null}

      {closed ? (
        <Text as="p" variant="sentence">
          {t("month.list.closedNote")}
        </Text>
      ) : null}

    </Flex>
  );
}

/**
 * `ArmazonEncabezado.dc.html` case 2 (RP-31, RP-32): the month screen. The
 * header names the month and leads back to the goal, with «Todos los meses»
 * for the phone; from 1024 `ListDetail` draws the goal's months beside it, the
 * month open.
 */
export async function MonthScreen({ goalId, month }: { goalId: string; month: string }) {
  const loaded = await loadGoal(goalId);
  if (!loaded) notFound();
  const goal = { ...loaded, months: settledMonths(loaded.months, loaded.endedOn !== null) };
  const mes = `${month}-01`;
  if (!goal.months.some((entry) => entry.month === mes)) notFound();

  const t = await getTranslations();
  return (
    <Page width="full">
      <ScreenHeader
        chat
        title={capitalised(yearLabel(mes))}
        back={{ href: `/metas/${goal.id}`, place: goal.name }}
        eyebrow={<TextLink href={`/metas/${goal.id}/meses`}>{t("month.list.allMonths")}</TextLink>}
      />
      <ListDetail
        show="detail"
        list={<MonthsList goal={goal} open={mes} />}
        detail={<MonthDetail goal={goal} month={month} />}
      />
    </Page>
  );
}
