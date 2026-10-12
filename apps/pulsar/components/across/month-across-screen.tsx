import type { ReactNode } from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { EvidenceNote } from "@/components/day/evidence-note";
import { TaskRow } from "@/components/month/task-row";
import { Button, Flex, Figure, Grid, Page, Panel, ScreenHeader, Section, Text, TextLink } from "@/components/ui";
import { planHrefFrom } from "@/lib/plan/return-to";
import { openMonthsOf, planMonthOf } from "@/lib/plan/roadmap-read";
import { loadMonthAcross, type MonthAcrossGoal, type MonthAcrossItem } from "@/lib/queries/month";
import { formatQuantity, isTimeUnit } from "@/lib/units/time";
import { timeWordsOf } from "@/lib/units/time-words";

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

/**
 * `MesTodas`, `MesTodasEscritorio`, `MesTodasVacio`, `MesTodasNada`,
 * `MesTodasHecho`, `MesTodasSinEvidencia` (RP-43, RP-31): this month of every
 * open goal, as `loadMonthAcross` reads it. Adding a task or an amount stays
 * on the goal's own month page, which each goal's name opens.
 */
export async function MonthAcrossScreen() {
  const across = await loadMonthAcross();
  const t = await getTranslations();
  const words = timeWordsOf(t as unknown as Parameters<typeof timeWordsOf>[0]);
  const monthNames = t.raw("day.monthLong") as string[];
  const weekdayNames = t.raw("day.weekdayLong") as string[];
  const monthName = (month: string) => monthNames[Number(month.slice(5, 7)) - 1];
  const seg = across.month.slice(0, 7);
  const thisName = monthName(across.month);
  const weekday = weekdayNames[(new Date(`${across.today}T12:00:00Z`).getUTCDay() + 6) % 7];
  const dateLine = `${weekday} ${Number(across.today.slice(8, 10))} de ${monthName(across.today)}`;

  // The `<fig>` tags of the month catalogue: each figure of a mixed line in mono.
  const fig = { fig: (chunks: ReactNode) => <Figure variant="meta" value={chunks} /> };

  // `where` is the goal a row of a general's block comes from; "" for the general's own, absent outside a group.
  function item(goal: MonthAcrossGoal, entry: MonthAcrossItem, where?: string) {
    const unit = goal.unit;
    const say = (n: number) => (unit ? formatQuantity(n, unit, words) : String(n));
    const noteEyebrow = t("oneOffs.note.eyebrowFull", { goal: goal.name, month: thisName });

    const openMonths = openMonthsOf(goal.plan);
    const sheetOf = (task: MonthAcrossItem["task"], kids: MonthAcrossItem["children"]) => ({
      goalId: goal.id,
      goalName: goal.name,
      unit,
      estimate: task.estimate,
      planMonth: planMonthOf(goal.plan, task.id)?.slice(0, 7) ?? null,
      months: task.parentId === null ? openMonths : [],
      canDelete: task.doneOn === null && kids.every((kid) => kid.doneOn === null),
      fixedMonth: task.plannedMonth?.slice(0, 7) ?? null,
    });

      const { task, children } = entry;
      const childTotal = sum(children.map((child) => child.estimate ?? 0));
      const childDone = sum(children.filter((child) => child.doneOn !== null).map((child) => child.estimate ?? 0));
      const isParent = children.length > 0;
      const owes = entry.carriedFrom !== null ? entry.owes : isParent ? childTotal : (task.estimate ?? 0);

      let sub: ReactNode;
      if (entry.carriedFrom !== null) {
        sub = entry.hasAmount
          ? t.rich("month.list.owes", { month: monthName(entry.carriedFrom), owes: say(entry.owes), ...fig })
          : t("month.list.fromMonth", { month: monthName(entry.carriedFrom) });
      } else if (isParent) {
        sub =
          childTotal > 0
            ? t.rich("month.list.doneOf", { done: say(childDone), total: say(childTotal), ...fig })
            : t.rich("month.list.doneOf", {
                done: children.filter((child) => child.doneOn !== null).length,
                total: children.length,
                ...fig,
              });
      }

      const placed =
        where === undefined ? sub : where === "" ? undefined : t("month.group.line", { goal: where, amount: say(owes) });
      return (
        <Flex key={task.id} direction="column">
          <TaskRow
            oneOffId={task.id}
            name={task.name}
            factId={task.factId ?? null}
            done={entry.done}
            parent={isParent}
            meta={placed}
            trailing={unit && owes > 0 && (where === undefined || where === "") ? say(owes) : undefined}
            markLabel={t("month.across.mark", { name: task.name })}
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
            fixedMonth={goal.plan.rhythm !== null ? task.plannedMonth?.slice(0, 7) : undefined}
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
              markLabel={t("month.across.mark", { name: child.name })}
              note={child.note}
              noteEyebrow={noteEyebrow}
              sheet={sheetOf(child, [])}
            />
          ))}
        </Flex>
      );
  }

  function block(goal: MonthAcrossGoal) {
    const unit = goal.unit;
    const say = (n: number) => (unit ? formatQuantity(n, unit, words) : String(n));
    const goalHref = `/metas/${goal.id}/meses/${seg}`;
    const carried = goal.items.filter((entry) => entry.carriedFrom !== null);
    const own = goal.items.filter((entry) => entry.carriedFrom === null);
    const carriedMonths = [...new Set(carried.map((entry) => entry.carriedFrom as string))];

    const leaves = goal.items.flatMap((entry) => (entry.children.length > 0 ? entry.children : [entry.task]));
    const doneInMonth = sum(
      leaves
        .filter((task) => task.doneOn !== null && task.doneOn.slice(0, 7) === seg)
        .map((task) => task.estimate ?? 0),
    );
    const ownPlanned = sum(own.map((entry) => entry.part));

    // With the dictionary unreadable, a goal with no amount to measure draws
    // its header and meta alone (`MesTodasSinEvidencia`).
    const collapsed = across.evidence === "unreadable" && (!goal.line || goal.line.planned === null);
    const doneTasks = leaves.filter((task) => task.doneOn !== null).length;

    let meta: ReactNode = null;
    if (!goal.line) {
      meta =
        goal.items.length === 0
          ? t("month.across.noTasks", { month: thisName })
          : collapsed
            ? t("month.across.measuresNothingCount", { done: doneTasks, total: leaves.length })
            : t("month.across.measuresNothing");
    } else if (goal.line.planned === null) {
      meta = t(goal.items.length === 0 ? "month.across.nothingPlanned" : "month.across.noAmount", {
        month: thisName,
      });
    } else if (across.evidence === "unreadable") {
      meta = t("month.declaredOnly");
    } else if (doneInMonth > 0) {
      meta = t.rich("month.list.includesDone", { done: say(doneInMonth), ...fig });
    }

    const planLink = collapsed
      ? null
      : goal.line && goal.line.planned === null
        ? { href: planHrefFrom(goal.id, seg, "/mes"), label: t("month.planMonth", { month: thisName }) }
        : goal.items.length === 0
          ? { href: `${goalHref}/tarea/nueva`, label: t("month.across.addTask") }
          : null;

    return (
      <Panel key={goal.id}>
        <Section as="div">
          <Text asChild variant="heading" rule>
            <h2>
              <Flex asChild align="center" justify="between" gap="2" minHeight="48px">
                <Text asChild link>
                  <Link href={goalHref}>
                    {goal.name}
                    <ChevronRight size={16} aria-hidden />
                  </Link>
                </Text>
              </Flex>
            </h2>
          </Text>
          {goal.line ? (
            <Flex align="baseline" gap="2">
              <Figure value={goal.line.reached} unit={unit ?? undefined} bare={goal.line.planned !== null} />
              {goal.line.planned !== null ? (
                <Text variant="sentence">
                  {t.rich("month.months.ofFigure", { planned: say(goal.line.planned), ...fig })}
                </Text>
              ) : null}
            </Flex>
          ) : null}
          {meta ? (
            <Text as="p" variant="sentence">
              {meta}
            </Text>
          ) : null}
          {planLink ? <TextLink href={planLink.href}>{planLink.label}</TextLink> : null}
        </Section>
        {collapsed ? null : carriedMonths.map((from) => (
          <Section key={from} as="div" label={t("month.list.fromMonth", { month: monthName(from) })}>
            {carried.filter((entry) => entry.carriedFrom === from).map((entry) => item(goal, entry))}
          </Section>
        ))}
        {!collapsed && own.length > 0 ? (
          <Section
            as="div"
            label={
              unit && isTimeUnit(unit) && ownPlanned > 0
                ? t("month.list.ownMonth", { month: thisName, planned: say(ownPlanned) })
                : t("month.list.fromMonth", { month: thisName })
            }
          >
            {own.map((entry) => item(goal, entry))}
          </Section>
        ) : null}
      </Panel>
    );
  }

  // A general and the goals under it, drawn as one block (RP-84): its figure is the sum of its goals,
  // its rows follow the tree and the done ones go last.
  function groupBlock(root: MonthAcrossGoal, members: MonthAcrossGoal[]) {
    const rows = members.flatMap((goal) =>
      goal.items.map((entry) => ({ goal, entry, where: goal.id === root.id ? "" : goal.name })),
    );
    const ordered = [...rows.filter((row) => !row.entry.done), ...rows.filter((row) => row.entry.done)];
    const say = (n: number) => (root.unit ? formatQuantity(n, root.unit, words) : String(n));
    return (
      <Panel key={root.id}>
        <Section as="div">
          <Text asChild variant="heading" rule>
            <h2>
              <Flex asChild align="center" justify="between" gap="2" minHeight="48px">
                <Text asChild link>
                  <Link href={`/metas/${root.id}/meses/${seg}`}>
                    {root.name}
                    <ChevronRight size={16} aria-hidden />
                  </Link>
                </Text>
              </Flex>
            </h2>
          </Text>
          {root.line ? (
            <Flex align="baseline" gap="2">
              <Figure value={root.line.reached} unit={root.unit ?? undefined} bare={root.line.planned !== null} />
              {root.line.planned !== null ? (
                <Text variant="sentence">
                  {t.rich("month.months.ofFigure", { planned: say(root.line.planned), ...fig })}
                </Text>
              ) : null}
            </Flex>
          ) : null}
        </Section>
        {ordered.length > 0 ? (
          <Section as="div" label={t("month.list.fromMonth", { month: thisName })}>
            {ordered.map(({ goal, entry, where }) => item(goal, entry, where))}
          </Section>
        ) : null}
      </Panel>
    );
  }

  const goalById = new Map(across.goals.map((goal) => [goal.id, goal]));
  const blocks = across.groups.map((group) => {
    const members = group.goalIds.map((id) => goalById.get(id)!);
    const root = goalById.get(group.rootId);
    return root && members.length > 1 ? groupBlock(root, members) : block(members[0]);
  });

  return (
    <Page width="full">
      <ScreenHeader title={thisName.charAt(0).toUpperCase() + thisName.slice(1)} meta={dateLine} />
      {across.goals.length === 0 ? (
        <Section as="div">
          <Text as="p" variant="sentence">
            {t("month.across.empty.title")}
          </Text>
          <Button asChild tap={52} block>
            <Link href="/metas/nueva">{t("month.across.empty.create")}</Link>
          </Button>
          <Button asChild tap={52} block variant="outline">
            <Link href="/metas/importar">{t("month.across.empty.import")}</Link>
          </Button>
        </Section>
      ) : (
        <>
          {across.evidence === "unreadable" ? (
            <EvidenceNote title={t("month.across.unreadableTitle")} body={t("month.across.unreadableBody")} />
          ) : null}
          <Grid columns={{ initial: "1", lg: "3" }} gap={{ initial: "6", md: "4" }} align="start">
            {blocks}
          </Grid>
        </>
      )}
    </Page>
  );
}
