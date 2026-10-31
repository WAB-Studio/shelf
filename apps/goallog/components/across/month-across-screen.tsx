import type { ReactNode } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ChevronRight } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { EvidenceNote } from "@/components/day/evidence-note";
import { TaskRow } from "@/components/month/task-row";
import { GiveDayList } from "@/components/one-offs/give-day-list";
import {
  Button,
  Face,
  Flex,
  Figure,
  Grid,
  Page,
  Panel,
  ScreenHeader,
  Section,
  SectionLabel,
  StepLinks,
  Text,
  TextLink,
} from "@/components/ui";
import { sentenceCase } from "@/lib/day/day-words";
import { cadencePhrase } from "@/lib/day/row-phrases";
import { closedMonthMarkDay } from "@/lib/plan/closed-month-marks";
import { monthSteps, parseMonthParam } from "@/lib/plan/month-param";
import { nextMonth } from "@/lib/plan/months";
import { mondaysTouching } from "@/lib/day/habit-weeks";
import { weekHref } from "@/lib/day/week-href";
import { planHrefFrom } from "@/lib/plan/return-to";
import { openMonthsOf, planMonthOf } from "@/lib/plan/roadmap-read";
import { loadMonthAcross, type MonthAcrossGoal, type MonthAcrossItem } from "@/lib/queries/month";
import { listComingDayless } from "@/lib/queries/one-offs";
import { formatQuantity, isTimeUnit } from "@/lib/units/time";
import { timeWordsOf } from "@/lib/units/time-words";
import { addDaysToCivilDate, civilDayMonthShort, weekOf } from "@/lib/zone";

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

// `/mes` for this month, `/mes?mes=YYYY-MM` for any other.
function monthHref(month: string | null, thisMonth: string): string | null {
  if (month === null) return null;
  return month === thisMonth ? "/mes" : `/mes?mes=${month}`;
}

/**
 * `MesTodas`, `MesTodasEscritorio`, `MesTodasVacio`, `MesTodasNada`,
 * `MesTodasHecho`, `MesTodasSinEvidencia` (RP-142, RP-31): a month of every
 * goal open in it, as `loadMonthAcross` reads it, stepped ‹ › one month at a
 * time. A past month reads as it was lived, and marks its tasks on its last
 * day only while that day is within a fact's reach (RP-143); a coming one
 * marks its tasks as this month does and lists after it what waits with no
 * day. Adding a task or an amount stays on the goal's own month page, which
 * each goal's name opens.
 */
export async function MonthAcrossScreen({ month, today }: { month?: string; today: string }) {
  const thisMonth = today.slice(0, 7);
  const coming = month !== undefined && month > thisMonth;
  // A coming month also offers the tasks that wait with no day: read beside the month, never after it.
  const [across, dayless] = await Promise.all([loadMonthAcross({ month, today }), coming ? listComingDayless(today) : []]);
  const seg = across.month.slice(0, 7);
  // The page cannot know the bounds before the read: a month past them lands on the nearer one; with no goal, on this one.
  const asked = parseMonthParam(seg, today, across.firstMonth, across.lastMonth);
  if (asked.kind === "redirect") redirect(monthHref(asked.to, thisMonth) ?? "/mes");
  const past = across.view === "past";
  const markDay = past ? closedMonthMarkDay(across.month, today) : undefined;
  const after = nextMonth(across.month);
  const thisMonday = weekOf(today)[0];
  // Unarchived and lasting past the month: what it left undone moves to the next one.
  const carriesOn = (goal: MonthAcrossGoal) => goal.open && (goal.plan.horizon === null || goal.plan.horizon > after);
  // A closed month counts a sub-task done only when it was done in it.
  const doneIn = (doneOn: string | null) => doneOn !== null && (!past || doneOn < after);
  const t = await getTranslations();
  const words = timeWordsOf(t as unknown as Parameters<typeof timeWordsOf>[0]);
  const monthNames = t.raw("day.monthLong") as string[];
  const weekdayNames = t.raw("day.weekdayLong") as string[];
  const monthName = (month: string) => monthNames[Number(month.slice(5, 7)) - 1];
  const thisName = monthName(across.month);
  const weekday = weekdayNames[(new Date(`${across.today}T12:00:00Z`).getUTCDay() + 6) % 7];
  const dateLine = t("day.date", {
    weekday,
    day: Number(across.today.slice(8, 10)),
    month: monthName(across.today),
  });

  // The `<fig>` tags of the month catalogue: each figure of a mixed line in mono.
  const fig = { fig: (chunks: ReactNode) => <Figure variant="meta" value={chunks} /> };

  // `where` is the goal a row of a general's block comes from; "" for the general's own, absent outside a group.
  function item(goal: MonthAcrossGoal, entry: MonthAcrossItem, where?: string) {
    const unit = goal.unit;
    const say = (n: number) => (unit ? formatQuantity(n, unit, words) : String(n));
    const noteEyebrow = t("oneOffs.note.eyebrowFull", { goal: goal.name, month: thisName });
    // A goal archived since marks nothing, even within the reach.
    const rowMarkDay = goal.open ? markDay : null;

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
      // A closed month past a fact's reach says how each task stood and marks nothing (RP-142, RP-143).
      if (rowMarkDay === null) {
        return (
          <Flex key={task.id} direction="column" gap="3">
            {[task, ...children].map((row) => (
              <Flex key={row.id} direction="column">
                <Text as="p" variant="name">
                  {row.name}
                </Text>
                <Text as="p" variant="meta">
                  {(row.id === task.id ? entry.done : doneIn(row.doneOn))
                    ? t("month.across.pastDone")
                    : // A plain task of its own month carries on while its goal does, as the goal's month page says.
                      row.id === task.id && children.length === 0 && entry.carriedFrom === null && carriesOn(goal)
                      ? t("month.list.staysIn", { month: monthName(after) })
                      : t("month.across.pastOpen")}
                </Text>
              </Flex>
            ))}
          </Flex>
        );
      }
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
            markDay={rowMarkDay}
            sheet={sheetOf(task, children)}
          />
          {children.map((child) => (
            <TaskRow
              key={child.id}
              oneOffId={child.id}
              name={child.name}
              factId={child.factId ?? null}
              done={doneIn(child.doneOn)}
              child
              trailing={unit && child.estimate ? say(child.estimate) : undefined}
              markLabel={t("month.across.mark", { name: child.name })}
              note={child.note}
              noteEyebrow={noteEyebrow}
              markDay={rowMarkDay}
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
    } else if (coming) {
      // A month not yet lived has reached nothing: it says its plan alone.
      meta =
        goal.line.planned === null
          ? t("month.across.comingNothingPlanned", { month: thisName })
          : t.rich("month.across.comingPlanned", { planned: say(goal.line.planned), month: thisName, ...fig });
    } else if (goal.line.planned === null) {
      meta = t(goal.items.length === 0 ? "month.across.nothingPlanned" : "month.across.noAmount", {
        month: thisName,
      });
    } else if (across.evidence === "unreadable") {
      meta = t("month.declaredOnly");
    }

    const planLink = collapsed || past
      ? null
      : goal.line && goal.line.planned === null
        ? { href: planHrefFrom(goal.id, seg, "/mes"), label: t("month.planMonth", { month: thisName }) }
        : goal.items.length === 0
          ? { href: `${goalHref}/tarea/nueva`, label: t("month.across.addTask") }
          : null;
    // The invitation says what «sin monto» would: a card holds one of the two.
    if (planLink && goal.line && goal.line.planned === null) meta = null;
    // A goal with tasks closes its card with the same link, to the real route.
    const addLink = !collapsed && !past && !planLink && goal.items.length > 0 ? `${goalHref}/tarea/nueva` : null;

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
          {goal.line && !coming ? (
            <Flex align="baseline" gap="2">
              <Figure value={goal.line.reached} unit={unit ?? undefined} bare={goal.line.planned !== null} />
              {goal.line.planned !== null ? (
                <>
                  {" "}
                  <Text variant="sentence">
                    {t.rich("month.months.ofFigure", { planned: say(goal.line.planned), ...fig })}
                  </Text>
                </>
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
        {addLink ? (
          <Section as="div">
            <TextLink href={addLink}>{t("month.across.addTask")}</TextLink>
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
                <>
                  {" "}
                  <Text variant="sentence">
                    {t.rich("month.months.ofFigure", { planned: say(root.line.planned), ...fig })}
                  </Text>
                </>
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

  // Habits with no goal (RP-100): what the month counted of each, never a mark.
  const habitsGroup =
    across.loose.length > 0 ? (
      <Panel key="habits">
        <Section as="div" label={t("month.across.habits.title")}>
          <Flex direction="column" gap="4">
            {across.loose.map((habit) => {
              const cadence =
                cadencePhrase((key, values) => t(key, values), habit.cadence, {
                  weekdayName: t.raw("day.cadence.weekdayName") as string[],
                  weekdayPlural: t.raw("day.cadence.weekdayPlural") as string[],
                }) ?? t("day.cadence.everyDay");
              return (
                <Flex key={habit.id} direction="column">
                  <Text as="p" variant="name">
                    <TextLink href={`/metas/habitos/${habit.id}?volver=/mes`}>{habit.name}</TextLink>
                  </Text>
                  <Text as="p" variant="meta">
                    {habit.weeks
                      ? habit.weeks.counted === 0
                        ? t("month.across.habits.noWeeks", { cadence })
                        : t("month.across.habits.lineWeeks", { cadence, ...habit.weeks })
                      : habit.asked === null
                      ? t("month.across.habits.line", { cadence, count: habit.daysDone })
                      : t("month.across.habits.lineOf", { cadence, done: habit.daysDone, asked: habit.asked })}
                    {habit.thisWeek ? ` · ${t("week.flexible.weekProgress", { done: habit.thisWeek.done, total: habit.thisWeek.count })}` : ""}
                  </Text>
                  {habit.retiredOn ? (
                    <Text as="p" variant="meta">
                      {t("habit.retiredOn", { date: civilDayMonthShort(habit.retiredOn) })}
                    </Text>
                  ) : null}
                </Flex>
              );
            })}
          </Flex>
        </Section>
      </Panel>
    ) : null;

  const { prev, next } = monthSteps({ month: seg, firstMonth: across.firstMonth, lastMonth: across.lastMonth });
  const stepLinks = (
    <StepLinks
      prev={{ href: monthHref(prev, thisMonth), label: t("month.across.nav.prev") }}
      next={{ href: monthHref(next, thisMonth), label: t("month.across.nav.next") }}
    />
  );
  const eyebrow = t(
    across.view === "this"
      ? "month.across.eyebrow.this"
      : coming
        ? "month.across.eyebrow.coming"
        : seg === across.firstMonth
          ? "month.across.eyebrow.first"
          : "month.across.eyebrow.past",
  );
  const title = thisName.charAt(0).toUpperCase() + thisName.slice(1);
  // One card takes the whole row, two share it, three or more fill three columns.
  const drawnCount = blocks.length + (habitsGroup ? 1 : 0);
  const nothingOpen = across.goals.length === 0 && across.loose.length === 0;
  const drawn = new Set(
    across.goals.flatMap((goal) => goal.items.flatMap((entry) => [entry.task.id, ...entry.children.map((kid) => kid.id)])),
  );

  return (
    <Page width="full">
      <ScreenHeader
        chat
        steps
        title={seg.slice(0, 4) === thisMonth.slice(0, 4) ? title : t("month.across.titleYear", { month: title, year: seg.slice(0, 4) })}
        meta={across.view === "this" ? sentenceCase(dateLine) : undefined}
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
      {nothingOpen ? null : (
        <Flex align="baseline" gap="3" wrap="wrap">
          <Text as="span" variant="meta">
            {t("month.across.weeks.label")}
          </Text>
          {mondaysTouching(across.month)
            // A week that ended before the first goal was opened has nothing in it.
            .filter((monday) => across.firstDay === null || addDaysToCivilDate(monday, 6) >= across.firstDay)
            .map((monday) => (
            <TextLink
              key={monday}
              nowrap
              href={weekHref(monday, thisMonday)}
              aria-label={t("month.across.weeks.link", { day: civilDayMonthShort(monday) })}
            >
              {civilDayMonthShort(monday)}
            </TextLink>
          ))}
        </Flex>
      )}
      {nothingOpen && across.view !== "this" ? (
        <Text as="p" variant="sentence">
          {t(coming ? "month.across.comingEmpty" : "month.across.pastEmpty", { month: thisName })}
        </Text>
      ) : nothingOpen ? (
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
          <Grid columns={{ initial: "1", lg: String(Math.min(3, Math.max(1, drawnCount))) as "1" | "2" | "3" }} gap={{ initial: "6", md: "4" }} align="start">
            {blocks}
            {habitsGroup}
          </Grid>
        </>
      )}
      {coming ? (
        <GiveDayList
          // A task the month already draws stays in its own row.
          tasks={dayless.filter((task) => !drawn.has(task.id))}
          suggest={across.month}
        />
      ) : null}
    </Page>
  );
}
