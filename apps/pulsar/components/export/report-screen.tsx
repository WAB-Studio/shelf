import type { ReactNode } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { getTranslations } from "next-intl/server";

import { type Translator } from "@/i18n/translator";
import { cadencePhrase } from "@/lib/day/row-phrases";
import { dayBefore } from "@/lib/day/weeks";
import {
  civilSpan,
  goalSections,
  isLongTable,
  keepsHeadWithTable,
  printsOnPaper,
  type Section as GoalSection,
} from "@/lib/export/sections";
import { endlessCut, foldsMonths } from "@/lib/lists/endless-cut";
import { distinctMeasureName } from "@/lib/export/measure";
import type { GoalReport, Report, ReportTask } from "@/lib/export/report";
import { screenPlanned } from "@/lib/plan/screen-planned";
import { formatCount, formatQuantity, isTimeUnit } from "@/lib/units/time";
import { civilDateToDate, civilDayMonthYear } from "@/lib/zone";
import {
  Figure,
  Flex,
  Mark,
  Page,
  Panel,
  PanelGrid,
  PrintBlock,
  PrintGoal,
  PrintHidden,
  PrintOnly,
  PrintPage,
  Row,
  ScreenHeader,
  Section,
  SectionLabel,
  Separator,
  SummaryList,
  Table,
  Text,
  TextLink,
  type TableRow,
} from "@/components/ui";
import { useTimeWords } from "@/components/ui/figure";

import { PrintButton } from "./print-button";

const monthYear = new Intl.DateTimeFormat("es-CO", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});
const monthOnly = new Intl.DateTimeFormat("es-CO", {
  month: "long",
  timeZone: "UTC",
});
const dateWithYear = new Intl.DateTimeFormat("es-CO", {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});
const dateWithWeekday = new Intl.DateTimeFormat("es-CO", {
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

// «agosto 2026»: the month and its year, without the «de» ICU puts between.
function monthLabel(day: string): string {
  const parts = monthYear.formatToParts(civilDateToDate(day));
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("month")} ${part("year")}`;
}

function MonthFigures({
  goal,
  declaredOnly,
  month,
  thisMonthKey,
  t,
}: {
  goal: GoalReport;
  declaredOnly: boolean;
  month: string;
  thisMonthKey: string;
  t: Translator<"export">;
}) {
  const unit = goal.unit as string;
  const paper = goal.thisMonth.planned;
  const screen = screenPlanned(paper, (goal.ownMonths ?? []).includes(thisMonthKey));
  const figures = (planned: number | null) => (
    <Flex direction="column" gap="1">
      <Figure value={goal.thisMonth.reached} unit={unit} bare={planned !== null} />
      {planned !== null ? (
        <Text variant="sentence">
          {t("of", { planned: "" })}
          <Figure variant="meta" value={planned} unit={unit} />
        </Text>
      ) : null}
      {declaredOnly ? <Text variant="sentence">{t("declaredOnly")}</Text> : null}
    </Flex>
  );
  return (
    <Section label={t("sections.month", { month })}>
      {screen === paper ? (
        figures(paper)
      ) : (
        <>
          <PrintHidden>{figures(screen)}</PrintHidden>
          <PrintOnly>{figures(paper)}</PrintOnly>
        </>
      )}
    </Section>
  );
}

// What closes a task's row: the amount owed (a carried task still open), its
// amount, or failing both the words the board uses: how many sub-tasks are
// done, «hecha», «pendiente».
// The task's whole estimate: its own, or its children's sum.
function totalOf(task: ReportTask): number | null {
  if (task.children.length === 0) return task.estimate;
  const estimates = task.children.flatMap((child) =>
    child.estimate === null ? [] : [child.estimate],
  );
  return estimates.length > 0 ? estimates.reduce((sum, value) => sum + value, 0) : null;
}

// Plain text, not a Figure: a sentence keeps its words in one run.
function Quantity({ value, unit }: { value: number; unit: string }) {
  const words = useTimeWords();
  return <Text variant="meta">{formatQuantity(value, unit, words)}</Text>;
}

function Trailing({
  task,
  unit,
  t,
}: {
  task: ReportTask;
  unit: string | null;
  t: Translator<"export">;
}) {
  if (task.part === null && task.children.length > 0) {
    return t("taskProgress", {
      done: task.children.filter((child) => child.done).length,
      total: task.children.length,
    });
  }
  const word = task.done ? t("taskDone") : t("taskPending");
  const amount =
    task.part !== null
      ? task.part
      : task.from !== null && !task.done && task.hasAmount
        ? task.owes
        : totalOf(task);
  if (unit !== null && amount !== null) {
    return (
      <>
        {`${word} · `}
        <Quantity value={amount} unit={unit} />
      </>
    );
  }
  return word;
}

function TaskLine({
  name,
  done,
  meta,
  continues,
  note,
  trailing,
  indented,
  of,
  t,
}: {
  name: string;
  done: boolean;
  meta?: ReactNode;
  continues?: ReactNode;
  note: string | null;
  trailing: ReactNode;
  indented?: boolean;
  // The goal a task of a group comes from, on the name's own line.
  of?: string;
  t: Translator<"export">;
}) {
  return (
    <Flex gap="3" align="start" py="3" pl={indented ? "6" : "1"} pr="1">
      <Mark state={done ? "declared" : "empty"} label={done ? t("taskDone") : t("taskPending")} />
      <Flex direction="column" gap="1" flexGrow="1" minWidth="0">
        <Text as="p" tone={done ? "muted" : "ink"}>
          {name}
          {of !== undefined ? (
            <Text variant="meta" tone="muted">
              {` · ${of}`}
            </Text>
          ) : null}
        </Text>
        {meta ? (
          <Text as="p" variant="sentence">
            {meta}
          </Text>
        ) : null}
        {continues ? (
          <Text as="p" variant="meta">
            {continues}
          </Text>
        ) : null}
        {note !== null ? (
          <Text as="p" tone="secondary" note>
            {note}
          </Text>
        ) : null}
      </Flex>
      <Flex flexShrink="0">
        <Text variant="sentence">{trailing}</Text>
      </Flex>
    </Flex>
  );
}

// «mide Práctica, en horas y minutos»: the unit in the words the goal's own screen uses.
function MeasureLine({
  name,
  unit,
  date,
  declared,
  t,
}: {
  name: string | null;
  unit: string;
  // Null for a goal with no end: the line says nothing of one.
  date: string | null;
  declared: boolean;
  t: Translator<"export">;
}) {
  const words = useTimeWords();
  const unitWords = isTimeUnit(unit) ? t("timeUnit") : (words.unit?.(unit, 2) ?? unit);
  const measure = distinctMeasureName(name, unit, [words.unit?.(unit, 1) ?? unit, words.unit?.(unit, 2) ?? unit]);
  return [
    measure === null ? t("measuresUnnamed", { unit: unitWords }) : t("measures", { measure, unit: unitWords }),
    date === null ? null : t("until", { date }),
    declared ? t("declaredOnly") : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");
}

// One line per goal inside a general: its month and amount, then its last day.
function InsideRow({
  goal,
  level,
  today,
  t,
}: {
  goal: GoalReport;
  level: 1 | 2;
  today: string;
  t: Translator<"export">;
}) {
  const words = useTimeWords();
  const until = goal.horizon === null ? null : dateWithYear.format(civilDateToDate(dayBefore(goal.horizon)));
  const planned =
    goal.endedOn === null && goal.unit !== null
      ? screenPlanned(goal.thisMonth.planned, (goal.ownMonths ?? []).includes(`${today.slice(0, 7)}-01`))
      : null;
  const meta =
    goal.endedOn !== null
      ? t("ended", { date: dateWithYear.format(civilDateToDate(goal.endedOn)) })
      : planned !== null
        ? [
            t("insideRow", {
              month: monthOnly.format(civilDateToDate(today)),
              done: formatQuantity(goal.thisMonth.reached, goal.unit as string, words),
              planned: formatQuantity(planned, goal.unit as string, words),
            }),
            until === null ? null : t("until", { date: until }),
          ]
            .filter((part) => part !== null)
            .join(" · ")
        : until === null
          ? undefined
          : t("until", { date: until });
  return <Row name={goal.name} meta={meta} href={`/metas/${goal.id}`} level={level} />;
}

// The first two tasks of a goal, and its last two, share a sheet: paper never opens or closes one on a task alone.
function inPairs(tasks: ReactNode[]): ReactNode[] {
  if (tasks.length < 2) return tasks;
  const pair = (key: string, run: ReactNode[]) => (
    <PrintBlock key={key} together>
      {run}
    </PrintBlock>
  );
  if (tasks.length <= 4) return [pair("all", tasks)];
  return [pair("first", tasks.slice(0, 2)), ...tasks.slice(2, -2), pair("last", tasks.slice(-2))];
}

function GoalPart({
  goal,
  declaredOnly,
  today,
  inside,
  all,
  t,
}: {
  goal: GoalReport;
  declaredOnly: boolean;
  today: string;
  // `?todo=1`: the screen lists a goal with no end from its opening; paper still prints its twelve.
  all: boolean;
  // The goals under a general, in preorder: the screen lists one line each.
  inside?: GoalReport[];
  t: Translator<"export">;
}) {
  const unit = goal.unit;
  const format = useFormatter();
  const commonT = useTranslations("common");
  const rootT = useTranslations();
  const words = useTimeWords();

  if (goal.endedOn !== null) {
    return (
      <PrintBlock whole>
        <Flex direction="column" gap="6">
          <Flex direction="column" gap="3">
            <Text asChild variant="name" rule>
              <h2>{goal.name}</h2>
            </Text>
            <Text as="p" variant="sentence">
              {t("ended", {
                date: dateWithYear.format(civilDateToDate(goal.endedOn)),
              })}
            </Text>
          </Flex>
          {unit !== null ? (
            <Section label={t("sections.atEnd")}>
              <Flex direction="column" gap="1">
                <Figure value={goal.toDate.reached} unit={unit} bare={goal.toDate.planned > 0} />
                {goal.toDate.planned > 0 ? (
                  <Text variant="sentence">
                    {t("of", { planned: "" })}
                    <Figure variant="meta" value={goal.toDate.planned} unit={unit} />
                  </Text>
                ) : null}
              </Flex>
            </Section>
          ) : null}
        </Flex>
      </PrintBlock>
    );
  }

  // Paper never opens «ver todo»: a goal with no end prints its last 12 months and those ahead set by hand, folds the
  // rest ahead into the rhythm's line and, when it has none, into the «sin monto» line. `?todo=1` only widens the screen.
  const cut = foldsMonths(goal.horizon, goal.months)
    ? endlessCut(goal.months, { all: false, rhythm: goal.rhythm, ends: goal.horizon === null ? undefined : { lastDay: dayBefore(goal.horizon) } })
    : null;
  const paperMonths = cut ? [...cut.shown, ...cut.empty.filter((month) => printsOnPaper(month, goal.unit))].sort((a, b) => a.month.localeCompare(b.month)) : goal.months;
  // Next month prints as a row though it is empty (RP-110).
  const printed = (month: GoalReport["months"][number]) => printsOnPaper(month, goal.unit, cut?.next?.month === month.month);
  const foldedMonths = cut ? cut.empty.filter((month) => !printsOnPaper(month, goal.unit)) : goal.months.filter((month) => !printsOnPaper(month, goal.unit));
  const paperKeys = new Set(paperMonths.map((month) => month.month));
  const screenMonths = all ? goal.months : paperMonths;
  // Months set by hand sit under the line, in a table of their own; «ver todo» lists every month in order.
  // A goal that holds goals keeps one table: its months are the sum of the goals inside, none is its own (RP-124).
  const paperOwn = new Set(cut && !goal.holdsGoals ? cut.handSet.map((month) => month.month) : []);
  const paperGoal: GoalReport = { ...goal, months: paperMonths };
  const aheadLine = cut?.line
    ? t.rich("ahead", {
        planned: cut.line.planned,
        fig: () => <Figure variant="meta" value={cut.line!.planned} unit={goal.unit as string} />,
      })
    : null;
  const restLine = cut?.rest ? t("rest", { count: cut.rest.count, date: civilDayMonthYear(cut.rest.lastDay) }) : null;
  const seeAll =
    cut && !all && cut.seeAll ? (
      <PrintHidden>
        <TextLink href="/exportar?todo=1">{commonT("seeAll")}</TextLink>
      </PrintHidden>
    ) : null;
  // Opened whole, a list that folds goes back to its fold; paper never draws it.
  const seeLess =
    cut && all && cut.seeAll ? (
      <PrintHidden>
        <TextLink href="/exportar">{commonT("seeLess")}</TextLink>
      </PrintHidden>
    ) : null;
  // A folded list names the closed months it hides before its first table: a link to «ver todo» on screen, text on paper.
  // Opened whole, neither face draws it.
  const earlierText = cut && !all && cut.hidden > 0 ? t("earlier", { count: cut.hidden }) : null;
  const earlierLine = earlierText ? (
    <Text as="p" variant="line">
      <TextLink href="/exportar?todo=1">{earlierText}</TextLink>
    </Text>
  ) : null;
  const earlierPaper = earlierText ? (
    <Text as="p" variant="line">
      {earlierText}
    </Text>
  ) : null;
  // A goal with an end whose list folds says its rows out of its months, on both faces.
  const ofMonths = (shown: number) => goal.horizon !== null && cut !== null && shown < goal.months.length;
  const captionOf = (shown: number, declared = false) =>
    ofMonths(shown)
      ? t(declared ? "monthsCaptionOfDeclared" : "monthsCaptionOf", { count: shown, total: goal.months.length })
      : t(declared ? "monthsCaptionDeclared" : "monthsCaption", { count: shown });
  // The rhythm's line (no end) opens the whole list on screen and comes before the months set by hand; `rest` opens nothing
  // and closes the last table, on both faces.
  const screenAhead =
    aheadLine && !all ? (
      <Text as="p" variant="line">
        <TextLink href="/exportar?todo=1">{aheadLine}</TextLink>
      </Text>
    ) : null;
  const ownLabel = paperOwn.size > 0 ? (aheadLine ? t("andOwn") : t("own")) : null;
  const screenLabel =
    screenAhead || ownLabel ? (
      <PrintHidden>
        {screenAhead}
        {ownLabel ? (
          <Text as="p" variant="line">
            {ownLabel}
          </Text>
        ) : null}
      </PrintHidden>
    ) : null;
  const screenRest =
    restLine && !all ? (
      <PrintHidden>
        <Text as="p" variant="line">
          {restLine}
        </Text>
      </PrintHidden>
    ) : null;
  const paperAhead = aheadLine ? (
    <Text as="p" variant="line">
      {aheadLine}
    </Text>
  ) : null;
  // On paper the label is the title of the own-amount table, held to its first row.
  const paperLabel = ownLabel ? (
    <Text as="p" variant="line">
      {ownLabel}
    </Text>
  ) : null;
  const paperRest = restLine ? (
    <Text as="p" variant="line">
      {restLine}
    </Text>
  ) : null;

  const held = inside !== undefined && inside.length > 0;
  // The screen lists every task of the group naming its goal; paper keeps each goal's own.
  const groupTasks = held
    ? [goal, ...inside].flatMap((member) => member.tasks.map((task) => ({ task, of: member.name })))
    : [];
  const sections: (GoalSection | "inside")[] = goalSections(paperGoal);
  if (groupTasks.length > 0 && !sections.includes("tasks")) sections.splice(sections.indexOf("months") === -1 ? sections.length : sections.indexOf("months"), 0, "tasks");
  if (held) sections.splice(sections.includes("toDate") ? sections.indexOf("toDate") + 1 : 0, 0, "inside");
  const until = goal.horizon === null ? null : dateWithYear.format(civilDateToDate(dayBefore(goal.horizon)));
  const thisMonth = monthOnly.format(civilDateToDate(today));

  const measureLine =
    unit === null ? (
      until === null ? t("noMeasure") : `${t("noMeasure")} · ${t("until", { date: until })}`
    ) : (
      <MeasureLine
        name={goal.measureName}
        unit={unit}
        date={until}
        declared={declaredOnly && goal.measureFed}
        t={t}
      />
    );

  const render = (section: GoalSection | "inside") => {
    switch (section) {
      case "inside":
        return (
          <Section label={t("inside", { count: inside!.length })}>
            {inside!.map((member) => (
              <InsideRow
                key={member.id}
                goal={member}
                level={member.parentId === goal.id ? 1 : 2}
                today={today}
                t={t}
              />
            ))}
          </Section>
        );
      case "month":
        return <MonthFigures goal={goal} declaredOnly={declaredOnly && goal.measureFed} month={thisMonth} thisMonthKey={`${today.slice(0, 7)}-01`} t={t} />;
      case "toDate":
        return (
          <Section label={t("sections.toDate")}>
            <Flex direction="column" gap="1">
              <Figure value={goal.toDate.reached} unit={unit as string} bare={goal.toDate.planned > 0} />
              {goal.toDate.planned > 0 ? (
                <Text variant="sentence">
                  {t("of", { planned: "" })}
                  <Figure variant="meta" value={goal.toDate.planned} unit={unit as string} />
                </Text>
              ) : null}
            </Flex>
          </Section>
        );
      case "commitments":
        return (
          <Section label={t("sections.commitments")}>
            {(goal.commitments ?? []).map((commitment, index) => {
              const cadence =
                cadencePhrase((key, values) => rootT(key, values), commitment.cadence, {
                  weekdayShort: rootT.raw("day.cadence.weekdayName") as string[],
                  weekdayPlural: rootT.raw("day.cadence.weekdayPlural") as string[],
                }) ?? rootT("day.cadence.everyDay");
              return (
                <Text key={`${commitment.name}-${index}`} as="p">
                  {commitment.targetQuantity !== null && commitment.unit !== null
                    ? t("commitmentAmount", {
                        name: commitment.name,
                        cadence,
                        amount: formatQuantity(commitment.targetQuantity, commitment.unit, words),
                      })
                    : t("commitmentLine", { name: commitment.name, cadence })}
                </Text>
              );
            })}
          </Section>
        );
      case "phases":
        return (
          <Section label={t("sections.phases")}>
            {goal.phases.map((phase) => (
              <Text key={phase.startsOn} as="p">
                <Text>{phase.aim}</Text>
                <Text variant="meta" tone="muted">
                  {" · "}
                  {civilSpan(phase.startsOn, phase.endsOn)}
                </Text>
                {phase.current ? <Text variant="sentence">{` · ${t("current")}`}</Text> : null}
              </Text>
            ))}
          </Section>
        );
      case "tasks": {
        const list = (items: { task: ReportTask; of?: string }[]) => (
          <Section label={t("sections.tasks", { month: thisMonth })} repeatLabel>
            {inPairs(items.map(({ task, of }, index) => (
              <Flex key={`${task.name}-${task.from ?? ""}-${index}`} direction="column">
                {index > 0 ? <Separator /> : null}
                <TaskLine
                  name={task.name}
                  of={of}
                  done={task.done}
                  meta={
                    task.from !== null
                      ? t("fromMonth", {
                          month: monthOnly.format(civilDateToDate(task.from)),
                        })
                      : undefined
                  }
                  continues={
                    unit !== null && task.part !== null && task.continuesIn !== null
                      ? t.rich("continuesIn", {
                          month: monthOnly.format(civilDateToDate(task.continuesIn)),
                          total: () => <Quantity value={totalOf(task) ?? 0} unit={unit} />,
                        })
                      : undefined
                  }
                  note={task.note}
                  trailing={<Trailing task={task} unit={unit} t={t} />}
                  t={t}
                />
                {task.children.map((child) => (
                  <Flex key={child.name} direction="column">
                    <Separator />
                    <TaskLine
                      name={child.name}
                      done={child.done}
                      note={child.note}
                      indented
                      trailing={
                        unit !== null && child.estimate !== null ? (
                          <>
                            {`${child.done ? t("taskDone") : t("taskPending")} · `}
                            <Quantity value={child.estimate} unit={unit} />
                          </>
                        ) : child.done ? (
                          t("taskDone")
                        ) : (
                          t("taskPending")
                        )
                      }
                      t={t}
                    />
                  </Flex>
                ))}
              </Flex>
            )))}
          </Section>
        );
        return list(held ? groupTasks : goal.tasks.map((task) => ({ task })));
      }
      case "months": {
        if (unit === null) {
          const rows: TableRow[] = screenMonths.map((month) => {
            const started = month.current || month.past;
            const tasks = month.tasks ?? { done: 0, total: 0 };
            const count =
              tasks.total === 0
                ? null
                : started
                  ? t("tasksDone", { done: tasks.done, total: tasks.total })
                  : t("tasksToDo", { count: tasks.total });
            const state = month.current ? t("current") : started ? t("closed") : t("upcoming");
            return {
              key: month.month,
              cells: [monthLabel(month.month), count, state],
              // The stacked face has no columns to hold them.
              note: count === null ? state : `${count} · ${state}`,
              printed: paperKeys.has(month.month) && printed(month),
            };
          });
          return (
            <Section
              label={t("byMonth", { goal: goal.name })}
              printSuffix={captionOf(paperMonths.filter(printed).length)}
            >
              <Table
                caption={captionOf(screenMonths.length)}
                columns={[t("columns.month"), t("columns.tasks"), t("columns.status")]}
                rows={rows}
                nowrapLabel
                stackInCard
                printLead={earlierPaper ?? undefined}
                after={
                  restLine ? (
                    <>
                      {screenRest}
                      {paperRest ? <PrintOnly>{paperRest}</PrintOnly> : null}
                    </>
                  ) : undefined
                }
              />
              {seeAll}
            </Section>
          );
        }
        const nextMonth = (month: string) => {
          const day = civilDateToDate(month);
          day.setUTCMonth(day.getUTCMonth() + 1);
          return monthOnly.format(day);
        };
        const timed = isTimeUnit(unit as string);
        const rowsOf = (list: GoalReport["months"]): TableRow[] => list.map((month) => {
          const started = month.current || month.past;
          const share = month.carried;
          const screenAmount = screenPlanned(month.planned, (goal.ownMonths ?? []).includes(month.month));
          const figureOf = (amount: number | null) =>
            amount === null ? null : <Figure variant="meta" value={amount} unit={unit as string} />;
          const plannedFigure = figureOf(screenAmount);
          // A share that rounds to 0 is blank on screen and still printed (RP-76).
          const paperOnly = screenAmount !== month.planned;
          const done = started ? (
            <Figure variant="meta" value={month.reached} unit={unit as string} />
          ) : null;
          const statusOf = (figure: ReactNode) =>
            month.current ? (
              <Text wrap="nowrap">{t("current")}</Text>
            ) : started ? (
              <>
                <Text wrap="nowrap">{t("closed")}</Text>
                {share !== null
                  ? ` · ${t("carriedTo", { percent: share, month: nextMonth(month.month) })}`
                  : null}
              </>
            ) : figure ? (
              <>
                {figure} <Text wrap="nowrap">{t("planned")}</Text>
              </>
            ) : (
              ""
            );
          const noAmount = <Text tone="secondary">{t("noAmount")}</Text>;
          const status = statusOf(plannedFigure) || noAmount;
          const taskCount = month.tasks?.total ?? 0;
          const tasksLine = taskCount > 0 ? t("tasksCount", { count: taskCount }) : null;
          const stack = (top: ReactNode, bottom: ReactNode) =>
            top && bottom ? (
              <>
                {top}
                <br />
                {bottom}
              </>
            ) : (top || bottom || undefined);
          const noteOf = (amount: number | null) =>
            amount === null ? undefined : timed ? (
              <>
                <Text variant="sentence">{t("of", { planned: "" })}</Text>
                {figureOf(amount)}
              </>
            ) : (
              <>
                {/* The note's own mono face, so «de» shares the figure's line box; a no-break
                    space, so it never stays behind when the unit drops a line. */}
                {`${t("of", { planned: "" }).trimEnd()}\u00a0`}
                <Figure variant="meta" value={amount} unit={unit as string} breakUnit />
              </>
            );
          // A started month's state sits in `detail`; its note only says the plan.
          const phoneNote = started ? noteOf(screenAmount) : status;
          const paperNote = paperOnly ? (
            <PrintOnly>{started ? noteOf(month.planned) : statusOf(figureOf(month.planned))}</PrintOnly>
          ) : undefined;
          return {
            key: month.month,
            cells: [
              monthLabel(month.month),
              done,
              paperOnly ? (
                <>
                  <PrintOnly>{figureOf(month.planned)}</PrintOnly>
                  {started ? null : <PrintHidden>{noAmount}</PrintHidden>}
                </>
              ) : (
                (plannedFigure ?? (started ? null : noAmount))
              ),
            ],
            detail: stack(started ? status : null, tasksLine),
            phoneFigure: started ? month.reached : null,
            phoneBare: screenAmount !== null,
            note:
              paperNote && !started ? (
                <>
                  {paperNote}
                  <PrintHidden>{noAmount}</PrintHidden>
                </>
              ) : (
                (paperNote ?? phoneNote)
              ),
            printed: paperKeys.has(month.month) && printed(month),
          };
        });
        // A goal with no end prints no line for its months ahead with neither an amount nor a task.
        const out = goal.horizon === null ? foldedMonths.filter((month) => (month.tasks?.total ?? 0) > 0) : foldedMonths;
        const outNames = format.list(
          out.map((m) => monthLabel(m.month)),
          { type: "conjunction" },
        );
        // A time goal with no rhythm counts tasks per month: the line groups the months by that count.
        const outGroups = out.some((m) => m.tasks !== undefined)
          ? out.reduce<{ total: number; months: typeof out }[]>((groups, m) => {
              const total = m.tasks?.total ?? 0;
              const group = groups.find((g) => g.total === total);
              if (group) group.months.push(m);
              else groups.push({ total, months: [m] });
              return groups;
            }, [])
          : null;
        const week = goal.weeks.find((w) => w.current);
        const weekPlanned = goal.weekPlanned ?? null;
        // A week the goal does not fill says from or to which day it counts.
        const weekDayOf = (day: string) => (civilDateToDate(day).getUTCDay() + 6) % 7;
        const weekNames = t.raw("weekDays") as string[];
        // `endsOn` runs to Sunday; the goal's last day cuts it.
        const lastDay = goal.horizon === null ? null : dayBefore(goal.horizon);
        const weekLast = week ? (lastDay !== null && lastDay < week.endsOn ? lastDay : week.endsOn) : null;
        const weekEdges =
          week && weekLast
            ? {
                edges:
                  week.startsOn === weekLast
                    ? "day"
                    : ["whole", "from", "to", "both"][(weekDayOf(week.startsOn) > 0 ? 1 : 0) + (weekDayOf(weekLast) < 6 ? 2 : 0)],
                from: weekNames[weekDayOf(week.startsOn)],
                to: weekNames[weekDayOf(weekLast)],
              }
            : null;
        const weekRows: TableRow[] = goal.weeks.map((w) => ({
          key: `week-${w.index}`,
          cells: [
            `${t("weekLabel", { n: w.index })} · ${civilSpan(w.startsOn, w.endsOn)}`,
            <Figure key="total" variant="meta" value={w.total} unit={unit as string} />,
            w.current ? <Text wrap="nowrap">{t("current")}</Text> : "",
          ],
          note: w.current ? t("current") : undefined,
        }));
        const outNode =
          out.length > 0 ? (
            outGroups ? (
              <>
                {outGroups.map((group) => (
                  <Text as="p" variant="line" key={group.total}>
                    {t("monthsOutCount", {
                      months: format.list(
                        group.months.map((m) => monthLabel(m.month)),
                        { type: "conjunction" },
                      ),
                      count: group.total,
                    })}
                  </Text>
                ))}
              </>
            ) : (
              <Text as="p" variant="line">
                {t("monthsOut", { months: outNames })}
              </Text>
            )
          ) : null;
        // On paper the rhythm's line and the label sit in the first table's `after`, `rest` in the last one's, with its last row.
        // On screen they sit between the tables and under the last one.
        const monthTables = (list: GoalReport["months"], own: ReadonlySet<string>) => {
          const first = list.filter((month) => !own.has(month.month));
          const ownList = list.filter((month) => own.has(month.month));
          const current = first.findIndex((m) => m.current);
          const paperFace = list === paperMonths;
          const closing = paperFace && (paperRest || outNode) ? (
            <>
              {paperRest}
              {outNode}
            </>
          ) : null;
          const firstAfter = paperFace && (paperAhead || (ownList.length === 0 && closing)) ? (
            <>
              {paperAhead}
              {ownList.length === 0 ? closing : null}
            </>
          ) : undefined;
          return (
            <>
              <Table
                caption={captionOf(list.length, declaredOnly)}
                showCaption={ofMonths(list.length)}
                above={seeLess ?? (paperFace ? earlierLine : null)}
                printLead={paperFace ? earlierPaper : undefined}
                columns={[t("columns.month"), t("columns.done"), t("columns.planned")]}
                rows={rowsOf(first)}
                figures={[1]}
                unit={unit as string}
                nowrapLabel
                stackInCard
                wrapDetail
                // «de 60 búsquedas» may break at a word; a time note never splits: it stays
                // beside the label when it fits, else drops whole under it.
                wrapNote={!timed}
                wholeNote={timed}
                current={current === -1 ? undefined : current}
                afterPrintOnly
                after={firstAfter}
              />
              {ownList.length > 0 ? (
                <>
                  {paperFace ? screenLabel : null}
                  <Table
                    caption=""
                    printTitle={paperFace ? paperLabel : undefined}
                    columns={[t("columns.month"), t("columns.done"), t("columns.planned")]}
                    rows={rowsOf(ownList)}
                    figures={[1]}
                    unit={unit as string}
                    nowrapLabel
                    stackInCard
                    wrapDetail
                    wrapNote={!timed}
                    wholeNote={timed}
                    afterPrintOnly
                    after={closing ?? undefined}
                  />
                </>
              ) : (
                paperFace ? screenLabel : null
              )}
              {paperFace ? screenRest : null}
            </>
          );
        };
        return (
          <Flex direction="column" gap="6">
            <Section
              label={t("byMonth", { goal: goal.name })}
              printSuffix={captionOf(paperMonths.filter(printed).length)}
            >
              {all ? (
                <>
                  <PrintHidden>{monthTables(screenMonths, new Set())}</PrintHidden>
                  <PrintOnly>{monthTables(paperMonths, paperOwn)}</PrintOnly>
                </>
              ) : (
                monthTables(paperMonths, paperOwn)
              )}
              {seeAll}
              {seeLess}
            </Section>
            {goal.weeks.length > 0 ? (
              <PrintHidden>
                <Section label={t("byWeek")}>
                  {week ? (
                    <Text as="p" variant="sentence">
                      {weekPlanned === null
                        ? t.rich("thisWeekDone", {
                            ...weekEdges!,
                            done: week.total,
                            fig: () => <Figure variant="meta" value={week.total} unit={unit as string} />,
                          })
                        : t.rich("thisWeek", {
                            ...weekEdges!,
                            done: week.total,
                            planned: weekPlanned,
                            fig: () => <Figure variant="meta" value={week.total} unit={unit as string} bare />,
                            plan: () => <Figure variant="meta" value={weekPlanned} unit={unit as string} />,
                          })}
                    </Text>
                  ) : null}
                  <Table
                    caption={t("weeksCaption", { count: goal.weeks.length })}
                    columns={[t("columns.week"), t("columns.done"), t("columns.status")]}
                    rows={weekRows}
                    figures={[1]}
                    unit={unit as string}
                    nowrapLabel
                    stackInCard
                    fold={t("showWeeks", { count: goal.weeks.length })}
                  />
                </Section>
              </PrintHidden>
            ) : null}
          </Flex>
        );
      }
    }
  };

  const spans = (section: GoalSection | "inside") => (section !== "month" && section !== "toDate" && section !== "commitments" ? "all" : undefined);
  return (
    <PrintGoal whole={keepsHeadWithTable(paperMonths, goal.unit)}>
      <PrintBlock span="lead">
        <Flex direction="column" gap="3">
          <Text asChild variant="name" rule>
            <h2>{goal.name}</h2>
          </Text>
          <Text as="p" variant="sentence">
            {measureLine}
          </Text>
          {goal.note ? (
            <PrintOnly>
              <Text as="p" tone="secondary" note>
                {goal.note}
              </Text>
            </PrintOnly>
          ) : null}
        </Flex>
      </PrintBlock>
      {sections.map((section) => (
        // A tall «por mes» breaks between its rows, so the goal's head never waits alone for a table that jumps a sheet.
        // A goal's figures never part: each block stays whole, so «ESTE MES» and «HASTA HOY» share their row and their sheet.
        <PrintBlock
          key={section}
          span={spans(section)}
          whole={section === "month" || section === "toDate" || (section === "months" && !isLongTable(paperMonths, goal.unit))}
        >
          {render(section)}
        </PrintBlock>
      ))}
    </PrintGoal>
  );
}

// `ExportarResumen`: page one, a line per open goal in the tree's order. The screen draws rows
// (a figure pair does not fit a line at 360), paper a table with «—» where a goal has no amount.
function ReportSummary({ report, t }: { report: Report; t: Translator<"export"> }) {
  const words = useTimeWords();
  const month = monthOnly.format(civilDateToDate(report.today));
  const monday = civilDateToDate(report.today);
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  const sunday = new Date(monday);
  sunday.setUTCDate(sunday.getUTCDate() + 6);
  const weekHead = t("summary.weekHead", { from: monday.getUTCDate(), to: sunday.getUTCDate() });

  const lines = report.goals
    .filter((goal) => goal.endedOn === null)
    .map((goal) => {
      const unit = goal.unit;
      const planned =
        unit === null
          ? null
          : screenPlanned(goal.thisMonth.planned, (goal.ownMonths ?? []).includes(`${report.today.slice(0, 7)}-01`));
      if (unit === null || planned === null) return { goal, month: null, week: null };
      const quantity = (value: number) => formatQuantity(value, unit, words);
      // «2.100 de 6.000 palabras»: the unit once, after the planned figure; time keeps its own words each side.
      const pair = (done: number, of: number) =>
        isTimeUnit(unit)
          ? t("summary.of", { done: quantity(done), planned: quantity(of) })
          : t("summary.of", { done: formatCount(done), planned: quantity(of) });
      const done = goal.weeks.find((w) => w.current)?.total ?? 0;
      const weekPlanned = goal.weekPlanned ?? null;
      return {
        goal,
        month: pair(goal.thisMonth.reached, planned),
        week: weekPlanned === null ? quantity(done) : pair(done, weekPlanned),
      };
    });
  const depth = new Map<string, 0 | 1 | 2>();
  const levelOf = (goal: GoalReport): 0 | 1 | 2 => {
    const above = goal.parentId ? depth.get(goal.parentId) : undefined;
    const level = (above === undefined ? 0 : Math.min(above + 1, 2)) as 0 | 1 | 2;
    depth.set(goal.id, level);
    return level;
  };
  const levels = lines.map((line) => levelOf(line.goal));

  return (
    <Section label={t("summary.title")}>
      <SummaryList
        head={{ goal: t("summary.goal"), month, week: weekHead }}
        noAmount={t("summary.noAmount")}
        rows={lines.map((line, index) => ({
          key: line.goal.id,
          href: `/metas/${line.goal.id}`,
          name: line.goal.name,
          level: levels[index],
          month: line.month === null ? null : `${month} ${line.month}`,
          week: line.week === null ? null : t("summary.week", { value: line.week }),
          monthCell: line.month,
          weekCell: line.week,
        }))}
      />
    </Section>
  );
}

/**
 * `ReporteTareas.dc.html`, `ReporteMesesSemanas.dc.html`,
 * `ReporteImpresoTareas.dc.html`, `ReporteMarcoEscritorio.dc.html` and
 * `ReporteMarcoEscritorio1024.dc.html` (RP-49), on top of `ReporteSinEvidencia.dc.html`
 * and `ReporteVacio.dc.html` (RP-49, RP-35): the whole report as one page the
 * browser prints. A goal prints the sections `goalSections` names and no
 * others, so one that measures nothing never prints a zero; a goal that has
 * ended prints its name, its last day and what it reached, and goes last.
 */
export async function ReportScreen({ report, showAll = false }: { report: Report; showAll?: boolean }) {
  const t = await getTranslations("export");

  const back = { href: "/metas", place: t("place") };

  if (report.goals.length === 0) {
    return (
      <Page width="full" print="full">
        <PrintPage>
          <ScreenHeader chat title={t("title")} back={back} eyebrow={t("eyebrowEmpty")} />
          <Text as="p" variant="sentence" tone="secondary">
            {t("empty")}
          </Text>
        </PrintPage>
      </Page>
    );
  }

  const declaredOnly = report.evidence === "unreadable";
  const byId = new Map(report.goals.map((goal) => [goal.id, goal]));
  // One entry per general (or lone goal); a report without `groups` stands every goal alone.
  const all = (report.groups ?? report.goals.map((goal) => ({ rootId: goal.id, goalIds: [goal.id] }))).flatMap((group) => {
    const [root, ...rest] = group.goalIds.flatMap((id) => byId.get(id) ?? []);
    return root ? [{ root, inside: rest }] : [];
  });
  const groups = [
    ...all.filter((group) => group.root.endedOn === null),
    ...all.filter((group) => group.root.endedOn !== null),
  ];
  const ended = groups.filter((group) => group.root.endedOn !== null).length;
  const holders = groups.filter((group) => group.inside.length > 0);
  const total = t("goalCount", { total: groups.length });
  const counted =
    holders.length > 0
      ? `${total} · ${t("insideCount", { holders: holders.length, inside: holders.reduce((sum, group) => sum + group.inside.length, 0) })}`
      : total;
  const count = ended > 0 ? `${counted} · ${t("endedCount", { ended })}` : counted;

  return (
    <Page width="full" print="full">
      <PrintPage>
        <Flex direction="column" gap="3">
          <ScreenHeader
            chat
            title={t("title")}
            back={back}
            eyebrow={
              <>
                <PrintHidden>
                  <SectionLabel>
                    {t("eyebrow", {
                      date: dateWithWeekday.format(civilDateToDate(report.today)),
                    })}
                  </SectionLabel>
                </PrintHidden>
                <PrintOnly>
                  <SectionLabel>
                    {t("printHead", {
                      brand: t("printBrand"),
                      date: dateWithYear.format(civilDateToDate(report.today)),
                    })}
                  </SectionLabel>
                </PrintOnly>
              </>
            }
            actions={<PrintButton label={t("download")} />}
          />
          <Text as="p" variant="sentence">
            {count}
          </Text>
          {declaredOnly ? (
            <Text as="p" variant="sentence" tone="secondary">
              {t("unreadable")}
            </Text>
          ) : null}
        </Flex>
        <ReportSummary report={report} t={t} />
        <PrintBlock newPage>
          <Section label={t("summary.annex")} />
        </PrintBlock>
        <PanelGrid print="stack">
          {groups.map(({ root, inside }) => (
            <Panel key={root.id} print="plain">
              <GoalPart goal={root} declaredOnly={declaredOnly} today={report.today} inside={inside} all={showAll} t={t} />
            </Panel>
          ))}
        </PanelGrid>
      </PrintPage>
    </Page>
  );
}
