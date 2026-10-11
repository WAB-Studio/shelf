import type { ReactNode } from "react";
import { useFormatter } from "next-intl";
import { getTranslations } from "next-intl/server";

import { type Translator } from "@/i18n/translator";
import { dayBefore } from "@/lib/day/weeks";
import {
  civilSpan,
  goalSections,
  isLongTable,
  keepsHeadWithTable,
  printsOnPaper,
  type Section as GoalSection,
} from "@/lib/export/sections";
import { distinctMeasureName } from "@/lib/export/measure";
import type { GoalReport, Report, ReportTask } from "@/lib/export/report";
import { formatQuantity, isTimeUnit } from "@/lib/units/time";
import { civilDateToDate } from "@/lib/zone";
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
  ScreenHeader,
  Section,
  SectionLabel,
  Separator,
  Table,
  Text,
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
  t,
}: {
  goal: GoalReport;
  declaredOnly: boolean;
  month: string;
  t: Translator<"export">;
}) {
  const unit = goal.unit as string;
  return (
    <Section label={t("sections.month", { month })}>
      <Flex direction="column" gap="1">
        <Figure value={goal.thisMonth.reached} unit={unit} bare={goal.thisMonth.planned !== null} />
        {goal.thisMonth.planned !== null ? (
          <Text variant="sentence">
            {t("of", { planned: "" })}
            <Figure variant="meta" value={goal.thisMonth.planned} unit={unit} />
          </Text>
        ) : null}
        {declaredOnly ? <Text variant="sentence">{t("declaredOnly")}</Text> : null}
      </Flex>
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
  t,
}: {
  name: string;
  done: boolean;
  meta?: ReactNode;
  continues?: ReactNode;
  note: string | null;
  trailing: ReactNode;
  indented?: boolean;
  t: Translator<"export">;
}) {
  return (
    <Flex gap="3" align="start" py="3" pl={indented ? "6" : "1"} pr="1">
      <Mark state={done ? "declared" : "empty"} label={done ? t("taskDone") : t("taskPending")} />
      <Flex direction="column" gap="1" flexGrow="1" minWidth="0">
        <Text as="p" tone={done ? "muted" : "ink"}>
          {name}
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
  date: string;
  declared: boolean;
  t: Translator<"export">;
}) {
  const words = useTimeWords();
  const unitWords = isTimeUnit(unit) ? t("timeUnit") : (words.unit?.(unit, 2) ?? unit);
  const key = declared ? "measuresDeclared" : "measures";
  const measure = distinctMeasureName(name, unit, [words.unit?.(unit, 1) ?? unit, words.unit?.(unit, 2) ?? unit]);
  return measure === null ? t(`${key}Unnamed`, { unit: unitWords, date }) : t(key, { measure, unit: unitWords, date });
}

function GoalPart({
  goal,
  declaredOnly,
  today,
  t,
}: {
  goal: GoalReport;
  declaredOnly: boolean;
  today: string;
  t: Translator<"export">;
}) {
  const unit = goal.unit;
  const format = useFormatter();

  if (goal.endedOn !== null) {
    return (
      <PrintBlock>
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

  const sections = goalSections(goal);
  const until = dateWithYear.format(civilDateToDate(dayBefore(goal.horizon)));
  const thisMonth = monthOnly.format(civilDateToDate(today));

  const measureLine =
    unit === null ? (
      t("noMeasure", { date: until })
    ) : (
      <MeasureLine
        name={goal.measureName}
        unit={unit}
        date={until}
        declared={declaredOnly && goal.measureFed}
        t={t}
      />
    );

  const render = (section: GoalSection) => {
    switch (section) {
      case "month":
        return <MonthFigures goal={goal} declaredOnly={declaredOnly && goal.measureFed} month={thisMonth} t={t} />;
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
      case "tasks":
        return (
          <Section label={t("sections.tasks", { month: thisMonth })}>
            {goal.tasks.map((task, index) => (
              <Flex key={`${task.name}-${task.from ?? ""}-${index}`} direction="column">
                {index > 0 ? <Separator /> : null}
                <TaskLine
                  name={task.name}
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
            ))}
          </Section>
        );
      case "months": {
        if (unit === null) {
          const rows: TableRow[] = goal.months.map((month) => {
            const started = month.current || month.past;
            const tasks = month.tasks ?? { done: 0, total: 0 };
            return {
              key: month.month,
              cells: [
                monthLabel(month.month),
                tasks.total === 0
                  ? t("noTasks")
                  : started
                    ? t("tasksDone", { done: tasks.done, total: tasks.total })
                    : t("tasksToDo", { count: tasks.total }),
                month.current ? t("current") : started ? t("closed") : t("upcoming"),
              ],
              printed: printsOnPaper(month),
            };
          });
          const out = goal.months.filter((m) => !printsOnPaper(m));
          return (
            <Section
              label={t("byMonth", { goal: goal.name })}
              printSuffix={t("monthsCaption", { count: goal.months.length - out.length })}
            >
              <Table
                caption={t("monthsCaption", { count: goal.months.length })}
                columns={[t("columns.month"), t("columns.tasks"), t("columns.status")]}
                rows={rows}
                nowrapLabel
                stackInCard
                after={
                  out.length > 0 ? (
                    <Text as="p" variant="line">
                      {t("monthsOutTasks", {
                        months: format.list(
                          out.map((m) => monthYear.format(civilDateToDate(m.month))),
                          { type: "conjunction" },
                        ),
                      })}
                    </Text>
                  ) : undefined
                }
              />
            </Section>
          );
        }
        const nextMonth = (month: string) => {
          const day = civilDateToDate(month);
          day.setUTCMonth(day.getUTCMonth() + 1);
          return monthOnly.format(day);
        };
        const timed = isTimeUnit(unit as string);
        const rows: TableRow[] = goal.months.map((month) => {
          const started = month.current || month.past;
          const share = month.carried;
          const plannedFigure =
            month.planned === null ? null : (
              <Figure variant="meta" value={month.planned} unit={unit as string} />
            );
          const done = started ? (
            <Figure variant="meta" value={month.reached} unit={unit as string} />
          ) : null;
          const status = month.current ? (
            <Text wrap="nowrap">{t("current")}</Text>
          ) : started ? (
            <>
              <Text wrap="nowrap">{t("closed")}</Text>
              {share !== null
                ? ` · ${t("carriedTo", { percent: share, month: nextMonth(month.month) })}`
                : null}
            </>
          ) : plannedFigure ? (
            <>
              {plannedFigure} <Text wrap="nowrap">{t("planned")}</Text>
            </>
          ) : (
            ""
          );
          // A started month's state sits in `detail`; its note only says the plan.
          const phoneNote = started ? (
            plannedFigure === null ? undefined : timed ? (
              <>
                <Text variant="sentence">{t("of", { planned: "" })}</Text>
                {plannedFigure}
              </>
            ) : (
              <>
                {/* The note's own mono face, so «de» shares the figure's line box; a no-break
                    space, so it never stays behind when the unit drops a line. */}
                {`${t("of", { planned: "" }).trimEnd()}\u00a0`}
                <Figure variant="meta" value={month.planned} unit={unit as string} breakUnit />
              </>
            )
          ) : (
            status
          );
          return {
            key: month.month,
            cells: [monthLabel(month.month), done, plannedFigure],
            detail: started ? status : undefined,
            phoneFigure: started ? month.reached : null,
            note: phoneNote,
            printed: printsOnPaper(month),
          };
        });
        const out = goal.months.filter((m) => !printsOnPaper(m));
        const outNames = format.list(
          out.map((m) => monthYear.format(civilDateToDate(m.month))),
          { type: "conjunction" },
        );
        const current = goal.months.findIndex((m) => m.current);
        const week = goal.weeks.find((w) => w.current);
        const weekPlanned = goal.weekPlanned ?? null;
        // A week the goal does not fill says from or to which day it counts.
        const weekDayOf = (day: string) => (civilDateToDate(day).getUTCDay() + 6) % 7;
        const weekNames = t.raw("weekDays") as string[];
        // `endsOn` runs to Sunday; the goal's last day cuts it.
        const weekLast = week ? (week.endsOn < dayBefore(goal.horizon) ? week.endsOn : dayBefore(goal.horizon)) : null;
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
        return (
          <Flex direction="column" gap="6">
            <Section
              label={t("byMonth", { goal: goal.name })}
              printSuffix={t("monthsCaption", { count: goal.months.length - out.length })}
            >
              <Table
                caption={t(declaredOnly ? "monthsCaptionDeclared" : "monthsCaption", {
                  count: goal.months.length,
                })}
                columns={[
                  t("columns.month"),
                  t("columns.done"),
                  t("columns.planned"),
                ]}
                rows={rows}
                figures={[1]}
                unit={unit as string}
                nowrapLabel
                stackInCard
                wrapDetail
                // «de 60 búsquedas» may drop its unit or the whole note a line; a time note keeps its line.
                wrapNote={!timed}
                current={current === -1 ? undefined : current}
                afterPrintOnly
                after={
                  out.length > 0 ? (
                    <Text as="p" variant="line">
                      {t("monthsOut", { months: outNames })}
                    </Text>
                  ) : undefined
                }
              />
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

  const spans = (section: GoalSection) => (section !== "month" && section !== "toDate" ? "all" : undefined);
  return (
    <PrintGoal whole={keepsHeadWithTable(goal.months)}>
      <PrintBlock span="lead">
        <Flex direction="column" gap="3">
          <Text asChild variant="name" rule>
            <h2>{goal.name}</h2>
          </Text>
          <Text as="p" variant="sentence">
            {measureLine}
          </Text>
        </Flex>
      </PrintBlock>
      {sections.map((section) => (
        <PrintBlock key={section} span={spans(section)} whole={section === "months" && !isLongTable(goal.months)} only={section === "months" && unit === null}>
          {render(section)}
        </PrintBlock>
      ))}
    </PrintGoal>
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
export async function ReportScreen({ report }: { report: Report }) {
  const t = await getTranslations("export");

  const back = { href: "/metas", place: t("place") };

  if (report.goals.length === 0) {
    return (
      <Page width="full" print="full">
        <PrintPage>
          <ScreenHeader title={t("title")} back={back} eyebrow={t("eyebrowEmpty")} />
          <Text as="p" variant="sentence" tone="secondary">
            {t("empty")}
          </Text>
        </PrintPage>
      </Page>
    );
  }

  const declaredOnly = report.evidence === "unreadable";
  const goals = [
    ...report.goals.filter((goal) => goal.endedOn === null),
    ...report.goals.filter((goal) => goal.endedOn !== null),
  ];
  const ended = report.goals.length - goals.filter((goal) => goal.endedOn === null).length;
  const count =
    ended > 0
      ? `${t("goalCount", { total: report.goals.length })} · ${t("endedCount", { ended })}`
      : t("goalCount", { total: report.goals.length });

  return (
    <Page width="full" print="full">
      <PrintPage>
        <Flex direction="column" gap="3">
          <ScreenHeader
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
        <PanelGrid print="stack">
          {goals.map((goal) => (
            <Panel key={goal.id} print="plain">
              <GoalPart goal={goal} declaredOnly={declaredOnly} today={report.today} t={t} />
            </Panel>
          ))}
        </PanelGrid>
      </PrintPage>
    </Page>
  );
}
