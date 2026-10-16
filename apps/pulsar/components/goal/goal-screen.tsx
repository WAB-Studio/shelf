import type { ReactNode } from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { type MessageKey, type Translator } from "@/i18n/translator";

import {
  ArchiveGoalAction,
  ReopenGoalButton,
} from "@/components/goal/archive-sheet";
import { EvidenceNote } from "@/components/day/evidence-note";
import { distinctMeasureName } from "@/lib/export/measure";
import { dayWords } from "@/lib/day/day-words";
import { phaseOn } from "@/lib/day/derive";
import { partOf, partWords } from "@/lib/plan/months";
import { showsPaceLine } from "@/lib/plan/pace-line";
import { planHrefFrom } from "@/lib/plan/return-to";
import { planMonthList } from "@/lib/plan/roadmap-read";
import { screenPlanned } from "@/lib/plan/screen-planned";
import { loadGoal } from "@/lib/queries/goal";
import { dayBefore, weekIndexOf } from "@/lib/day/weeks";
import { formatQuantity, isTimeUnit, type TimeWords } from "@/lib/units/time";
import {
  civilDateInZone,
  civilDayMonthShort,
  todayInZone,
  TIME_ZONE,
  civilDateLabel,
} from "@/lib/zone";
import {
  Button,
  Face,
  Figure,
  Flex,
  Mark,
  Notice,
  Page,
  Panel,
  Progress,
  Row,
  ScreenHeader,
  Section,
  SectionLabel,
  Split,
  Text,
  TextLink,
} from "@/components/ui";

import { CommitmentList, countWord } from "./commitment-list";
import { horizonWeeks, weekIndex } from "./phase-weeks";
import { CreateInsideAction } from "./create-inside-sheet";
import { MoveEndRow, MoveHorizonAction } from "./horizon-sheet";
import { DeleteGoalSheet } from "./delete-goal-sheet";
import { MeasureAction } from "./measure-sheet";
import { RhythmSheet } from "@/components/plan/rhythm-sheet";
import { GoalNote } from "./goal-note-sheet";
import { MoveGoalAction } from "./move-sheet";
import { RenameGoalAction } from "./rename-sheet";

// "22 de septiembre de 2026": the day a goal was opened or archived, in the person's
// own zone (RNP-06) and in words, never a locale this design does not
// otherwise use.
function longDateLabel(instant: string): string {
  return new Intl.DateTimeFormat("es-CO", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: TIME_ZONE,
  }).format(new Date(instant));
}

// «lunes 28 de septiembre»: the month always, so the week of today is not
// asked for by `dayWords`; a day of 1970 is never in it.
function endedOnWords(endedOn: string, t: Translator): string {
  const words = dayWords(endedOn, "1970-01-01");
  const weekdays = t.raw("day.weekdayLong") as string[];
  const months = t.raw("day.monthLong") as string[];
  return t("goal.detail.endedOn", {
    weekday: weekdays[words.weekday],
    day: words.day,
    month: months[words.month ?? 0],
    year: endedOn.slice(0, 4),
  });
}

function phaseSpanLabel(
  openedOn: string,
  startsOn: string,
  endsOn: string | null,
  t: Translator,
): ReactNode {
  const start = weekIndex(openedOn, startsOn);
  const end = endsOn ? weekIndex(openedOn, endsOn) : start;
  // A phase stored before its goal opened reads from week 1, never week 0.
  return t.rich("goal.detail.phaseSpan", {
    start: Math.max(1, start),
    end: Math.max(1, end),
    fig: (chunks: ReactNode) => <Figure variant="meta" value={chunks} />,
  });
}

/**
 * `Meta.dc.html` (RP-11, RP-14, RP-15): a goal's commitments, their cadence
 * and what satisfies them, and its phases — a retired commitment stays in
 * the list, a phase not in effect today draws outlined rather than filled.
 * The measure is a figure, drawn only once the goal has one (§0.3, 3): a
 * goal whose first quantity commitment has not landed yet has nothing to
 * show and nothing to sum.
 */
export async function GoalScreen({ goalId }: { goalId: string }) {
  const goal = await loadGoal(goalId);
  if (!goal) notFound();

  const t = await getTranslations();
  const today = todayInZone();
  // A goal with no end has no last day: nothing below reads one.
  const endDay = goal.horizon === null ? null : dayBefore(goal.horizon);
  const endLabel = endDay === null ? null : `${civilDayMonthShort(endDay)} ${endDay.slice(0, 4)}`;
  const openedOn = civilDateInZone(new Date(goal.createdAt));
  const totalWeeks = horizonWeeks(openedOn, goal.horizon);
  const currentPhase = phaseOn(goal.phases, today);

  const levelName =
    goal.level === null ? "" : t(`tree.levels.${goal.level === "large" ? "grande" : goal.level === "small" ? "pequena" : "general"}`);
  const archived = goal.archivedAt !== null;
  const ended = goal.endedOn !== null && !archived;
  // The end sheet counts from this week: an ended goal opens on 1 (it ends this Sunday).
  const sheetWeeks = ended ? 1 : endDay === null ? null : weekIndexOf(today, endDay);
  const holds = goal.holdsGoals;
  const insideAction =
    archived || ended || goal.level === "small" ? null : (
      <CreateInsideAction
        goalId={goal.id}
        name={goal.name}
        horizon={goal.horizon}
        kind={goal.level === "large" ? "small" : "big"}
        rhythm={goal.rhythm !== null}
      />
    );
  // The open goals under this one, in plan order: what archiving it takes along.
  const branchNames = goal.tree
    .filter((node) => node.archivedAt === null && node.ancestors.includes(goal.id))
    .map((node) => node.name);
  const archiveBranch = { branchCount: goal.branchOpenCount, branchNames };
  const moveProps = {
    goalId: goal.id,
    name: goal.name,
    openedOn,
    horizon: goal.horizon,
    weeks: sheetWeeks,
    phases: goal.phases,
    reopening: ended,
    above: goal.above,
    below: goal.tree
      .filter((node) => node.ancestors.includes(goal.id))
      .map((node) => ({ id: node.id, name: node.name, horizon: node.horizon })),
  };
  const moveAction = <MoveHorizonAction {...moveProps} />;

  const deleteAction = (block: boolean) =>
    goal.deletable ? (
      <DeleteGoalSheet goalId={goal.id} name={goal.name} above={goal.parent?.id ?? null} block={block} />
    ) : null;

  const phoneActs = ended ? (
    <Face on="phone">
      <Section as="div">
        {moveAction}
        <ArchiveGoalAction goalId={goal.id} name={goal.name} short {...archiveBranch} />
        {deleteAction(true)}
      </Section>
    </Face>
  ) : null;

  // `MetaMes*.dc.html` (RP-28, RP-29): the current month's amount, drawn only
  // with a measure and a month inside the span. A time unit prints itself in
  // hours and minutes; any other unit is named beside each figure, as the total is.
  const month = goal.month;
  const figureUnit = goal.measureUnit ?? undefined;
  const monthName = (t.raw("day.monthLong") as string[])[Number(today.slice(5, 7)) - 1];
  // Days to the month's end, or to the goal's own last day when that comes first.
  const monthEnd = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0)).toISOString().slice(0, 10);
  const lastDay = endDay !== null && endDay < monthEnd ? endDay : monthEnd;
  const daysLeft = Math.round((Date.parse(`${lastDay}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
  const planned = screenPlanned(month?.planned ?? null, goal.plan.budgets.some((budget) => budget.month === `${today.slice(0, 7)}-01`));
  const percent = month && planned ? Math.floor((month.reached * 100) / planned) : 0;
  // A goal with no measure has no amount to read, but its months and their
  // tasks stay reachable (`MetaSinMedida.dc.html`).
  const bareMonth = !holds && !goal.measureUnit && goal.months.some((row) => row.current);
  const monthKey = `${today.slice(0, 7)}-01`;
  const own = planMonthList(goal.plan, monthKey).filter((item) => item.carriedFrom === null);
  // A goal with no measure that holds no task this month has nothing to say of
  // it (RP-73, never «0 tareas»); «Ver por mes» is still the way to the months that do.
  const noMonthBlock = bareMonth && own.length === 0;
  const units = await getTranslations("units");
  const words: TimeWords = {
    h: (h) => units("h", { h }),
    min: (min) => units("min", { min }),
    join: (h, min) => units("join", { h, min }),
  };
  // The catalogue's word for a stored unit; a unit it lacks prints as typed.
  const unitWord = (unit: string) => {
    const key = `units.words.${unit.trim().toLowerCase()}` as MessageKey;
    return /^\p{L}+$/u.test(unit.trim()) && t.has(key) ? t(key, { count: 2 }) : unit;
  };
  const fig = { fig: (chunks: ReactNode) => <Figure variant="meta" value={chunks} /> };
  const monthNames = t.raw("day.monthLong") as string[];
  const planEnd = goal.roadmap.end;
  // The row says the whole rhythm; only the month's figures carry its share.
  const planAmount = goal.plan.rhythm;
  const monthOwn = goal.plan.rhythm !== null && goal.plan.budgets.some((budget) => budget.month === monthKey);
  const planItems = planMonthList(goal.plan, monthKey);
  const planDone = planItems.filter((item) => item.done).length;
  const planEndLabel = planEnd
    ? t("day.dateYear", {
        day: Number(planEnd.slice(8, 10)),
        month: monthNames[Number(planEnd.slice(5, 7)) - 1],
        year: planEnd.slice(0, 4),
      })
    : null;
  // A goal with no measure keeps its plan; one measured in something else has none.
  const measuresOther = goal.measureUnit !== null && !isTimeUnit(goal.measureUnit);
  const planSection =
    holds || goal.roadmap.state === "empty" || measuresOther ? null : (
      <Section label={t("roadmap.meta.planLabel")}>
        <Row
          href={`/metas/${goal.id}/plan`}
          card
          name={
            goal.roadmap.state === "noRhythm"
              ? t("roadmap.meta.build")
              : planEndLabel
                ? t("roadmap.meta.finish", { date: planEndLabel })
                : t("roadmap.plan.title")
          }
          meta={
            goal.roadmap.state === "planned" && planAmount !== null
              ? t.rich(planItems.length === 0 ? "roadmap.meta.rhythmLine" : "roadmap.meta.rhythmLineDone", {
                  amount: formatQuantity(planAmount, goal.measureUnit ?? "", words),
                  done: planDone,
                  total: planItems.length,
                  month: monthName,
                  ...fig,
                })
              : undefined
          }
          metaVariant="sentence"
          trailing={<ChevronRight size={16} strokeWidth={1.5} aria-hidden />}
        />
      </Section>
    );
  // A unit other than time has no plan, only the rhythm every month without an amount of its own takes (RP-101).
  const rhythmUnit = goal.measureUnit;
  const rhythmSection =
    measuresOther && rhythmUnit !== null && !holds && (goal.rhythm !== null || (!archived && !ended)) ? (
      <Section label={t("roadmap.meta.rhythmLabel")}>
        {goal.rhythm === null ? (
          <RhythmSheet
            goalId={goal.id}
            goalName={goal.name}
            unit={rhythmUnit}
            plan={goal.plan}
            initial={null}
            name={t("roadmap.meta.rhythmOffer")}
            meta={t("roadmap.meta.rhythmOfferHint", { unit: unitWord(rhythmUnit) })}
          />
        ) : archived || ended ? (
          <Row
            card
            name={t("roadmap.meta.rhythmOtherLine", { amount: formatQuantity(goal.rhythm, rhythmUnit, words) })}
            meta={t("roadmap.meta.rhythmOtherHint")}
            metaVariant="sentence"
            disabled
          />
        ) : (
          <RhythmSheet
            goalId={goal.id}
            goalName={goal.name}
            unit={rhythmUnit}
            plan={goal.plan}
            initial={goal.rhythm}
            name={t("roadmap.meta.rhythmOtherLine", { amount: formatQuantity(goal.rhythm, rhythmUnit, words) })}
            meta={t("roadmap.meta.rhythmOtherHint")}
          />
        )}
      </Section>
    ) : null;
  const monthsLink = (
    <TextLink href={`/metas/${goal.id}/meses`}>{t("goal.detail.monthsLink")}</TextLink>
  );
  const bareBlock = bareMonth && !noMonthBlock ? (
    <Panel>
      <Section label={monthName}>
        <Text as="p" variant="sentence" tone="secondary">
          {t("month.months.withoutMeasure.goalTasks", {
            count: own.length,
            done: own.filter((item) => item.done).length,
          })}
        </Text>
        {monthsLink}
      </Section>
    </Panel>
  ) : null;
  // Under 60 % from the 20th the pace line holds reached «de» planned itself.
  const part = partOf(monthKey, goal.plan);
  const paceLine = !holds && showsPaceLine({
    planned,
    underPace: Boolean(month?.underPace),
    unreadable: goal.evidence === "unreadable",
    ended,
  });
  const monthBlock =
    goal.measureUnit && month ? (
      <Section label={monthName}>
        {paceLine ? (
          <Text as="p" variant="sentence">
            {t("goal.detail.monthPace", { day: Number(today.slice(8, 10)) })}{" "}
            <Figure value={month.reached} unit={figureUnit} variant="meta" bare />{" "}
            {t("day.monthLine.of")} <Figure value={planned as number} unit={figureUnit} variant="meta" />
            {t("goal.detail.monthPaceUnder", { threshold: 60 })}
          </Text>
        ) : (
          <Text as="p" variant="sentence" tone="muted">
            <Figure value={month.reached} unit={figureUnit} variant="measure" bare={planned !== null} />{" "}
            {planned !== null ? (
              <>
                {t("day.monthLine.of")} <Figure value={planned} unit={figureUnit} variant="meta" />
              </>
            ) : (
              t(holds ? "tree.goal.noAmount" : "goal.detail.monthNoPlan")
            )}
          </Text>
        )}
        {part ? (
          <Text as="p" variant="sentence" tone="muted">
            {t.rich("goal.detail.monthPart", {
              ...partWords(part, monthKey, goal.measureUnit ?? "", (n) => formatQuantity(n, goal.measureUnit ?? "", words)),
              ...fig,
            })}
          </Text>
        ) : null}
        {monthOwn ? (
          <Text as="p" variant="sentence" tone="muted">
            {t("goal.detail.monthInLieu")}
          </Text>
        ) : null}
        {planned !== null && planned > 0 ? (
          <>
            <Progress percent={percent} />
            {goal.evidence === "unreadable" ? (
              <Text as="p" variant="sentence" tone="muted">
                {t("goal.detail.monthDeclaredOnly")}
              </Text>
            ) : paceLine ? null : (
              <Text as="p" variant="sentence" tone="muted">
                {holds
                  ? t("tree.goal.monthSum", { percent })
                  : ended
                    ? t("goal.detail.monthProgressEnded", { percent })
                    : t("goal.detail.monthProgress", { percent, days: daysLeft })}
              </Text>
            )}
          </>
        ) : null}
        {measuresOther && planItems.length > 0 ? (
          <Text as="p" variant="line">
            {t("goal.detail.monthTasks", { done: planDone, total: planItems.length })}
          </Text>
        ) : null}
        {planned === null && !holds && !archived && !ended ? (
          <Button asChild variant="outline">
            <Link href={planHrefFrom(goal.id, today.slice(0, 7), `/metas/${goal.id}`)}>
              {t("goal.detail.monthPlanLink", { month: monthName })}
            </Link>
          </Button>
        ) : null}
      </Section>
    ) : null;

  const endPanel = (
      <Panel>
        <Face on="desktop">
          <SectionLabel>{t("goal.detail.endHeading")}</SectionLabel>
        </Face>
        {goal.endedOn ? (
          <Text as="p" variant="sentence">
            {endedOnWords(goal.endedOn, t)}
          </Text>
        ) : (
          <MoveEndRow {...moveProps} reopening={archived || ended}>
            <Text as="p" variant="sentence" tone="muted">
              {endLabel === null
                ? t("goal.detail.noEnd")
                : t("goal.detail.horizonUntil", {
                    weeks: totalWeeks ?? 0,
                    date: endLabel,
                  })}
            </Text>
          </MoveEndRow>
        )}
        {goal.measureUnit ? null : (
          <Text as="p" variant="sentence" tone="muted">
            {t("month.list.noMeasure")}
          </Text>
        )}
        {goal.measureUnit || holds || archived || ended ? null : <MeasureAction goalId={goal.id} goalName={goal.name} />}
        {goal.measureUnit && !holds && !archived && !ended && !goal.measureFed ? (
          <MeasureAction
            goalId={goal.id}
            goalName={goal.name}
            current={{ name: goal.measureName ?? "", unit: goal.measureUnit }}
            fed={goal.measureFed}
            rhythm={goal.rhythm !== null}
            months={goal.plan.budgets.length}
          />
        ) : null}
        {ended ? <Face on="desktop">{moveAction}</Face> : null}
      </Panel>
  );

  const notices = goal.outOfUnit.filter(
    (other) => (goal.children.find((child) => child.id === other.id)?.month?.planned ?? 0) > 0,
  );
  const noticeLines = notices.map((other) => (
    <Notice key={other.id} role="note">
      {t("tree.goal.otherUnit", { name: other.name, unit: unitWord(other.unit) })}
    </Notice>
  ));

  const measureName = goal.measureUnit
    ? distinctMeasureName(goal.measureName, goal.measureUnit, [unitWord(goal.measureUnit)])
    : null;
  const measurePanel = (
      goal.measureUnit ? (
        <Panel>
          <Text as="p" variant="sentence" tone="muted">
            {measureName !== null
              ? isTimeUnit(goal.measureUnit)
                ? t("goal.detail.measuresNamedTime", { name: measureName })
                : t("goal.detail.measuresNamed", { name: measureName, unit: unitWord(goal.measureUnit) })
              : isTimeUnit(goal.measureUnit)
                ? t("goal.detail.measuresTime")
                : t("goal.detail.measures", { unit: unitWord(goal.measureUnit) })}
          </Text>
          {phoneActs}

          {goal.measureUnit ? (
            <Figure
              value={goal.measureTotal}
              unit={goal.measureUnit}
              variant="measure"
            />
          ) : null}
          <Text as="p" variant="sentence" tone="muted">
            {t.rich("goal.detail.measureSince", {
              date:
                openedOn.slice(0, 4) === today.slice(0, 4)
                  ? civilDateLabel(openedOn)
                  : t("goal.detail.measureSinceYear", { date: civilDateLabel(openedOn), year: openedOn.slice(0, 4) }),
              fig: (chunks) => <Figure variant="meta" value={chunks} />,
            })}
          </Text>

          {monthBlock}
          {noticeLines}

          <Section as="div">
            <Flex wrap="wrap" gap="4">
              {month || noMonthBlock ? monthsLink : null}
              <TextLink href={`/metas/${goal.id}/revision`}>
                {t("goal.detail.reviewLink")}
              </TextLink>
            </Flex>
          </Section>

          {goal.measureUnit && goal.evidence === "unreadable" ? (
            <EvidenceNote title={t("goal.detail.unreadableTitle")} body={t("goal.detail.unreadableBody")} />
          ) : null}
        </Panel>
      ) : (
        <>
          {phoneActs}
          {bareBlock}
          {noMonthBlock ? (
            <Section as="div">{monthsLink}</Section>
          ) : null}
        </>
      )
  );

  // `JerarquiaMetaGeneral`: the goals directly under, each with its month and its last day.
  const openChildren = goal.children.filter((child) => child.archivedAt === null);
  const openBelow = (id: string) =>
    (goal.tree.find((node) => node.id === id)?.children ?? []).filter(
      (kid) => goal.tree.find((node) => node.id === kid)?.archivedAt === null,
    ).length;
  const dayLabel = (day: string) => `${civilDayMonthShort(day)} ${day.slice(0, 4)}`;
  const childMonth = (child: (typeof openChildren)[number]) => {
    if (!child.month || child.month.planned === null) return undefined;
    const unit = child.unit ?? undefined;
    return (
      <>
        {monthName} · <Figure value={child.month.reached} unit={unit} variant="meta" bare />{" "}
        {t("day.monthLine.of")} <Figure value={child.month.planned} unit={unit} variant="meta" />
      </>
    );
  };
  const insidePanel =
    holds && openChildren.length > 0 ? (
      <Panel>
        <Section label={t("tree.goal.inside")}>
          <Flex direction="column">
            {openChildren.map((child) => {
              const node = goal.tree.find((entry) => entry.id === child.id);
              const end = node ? node.horizon : goal.horizon;
              const last = end === null ? null : dayLabel(dayBefore(end));
              const count = openBelow(child.id);
              const until =
                last === null
                  ? count > 0
                    ? t("tree.list.noEndInside", { count })
                    : t("goal.list.noEnd")
                  : count > 0
                    ? t("tree.list.untilInside", { date: last, count })
                    : t("tree.list.until", { date: last });
              return (
                <Row
                  key={child.id}
                  href={`/metas/${child.id}`}
                  name={child.name}
                  narrowMetaAbove={childMonth(child)}
                  meta={until}
                  wideMeta={childMonth(child)}
                  wideTrailing={childMonth(child) ? <Text variant="meta">{until}</Text> : undefined}
                  trailing={<ChevronRight size={16} strokeWidth={1.5} aria-hidden />}
                />
              );
            })}
          </Flex>
          {insideAction}
        </Section>
      </Panel>
    ) : null;

  const before = holds ? (
    <>
      {measurePanel}
      {insidePanel}
      {endPanel}
    </>
  ) : (
    <>
      {planSection}
      {rhythmSection}
      {endPanel}
      {measurePanel}
    </>
  );

  const main = (
    <Panel as="div">
      <CommitmentList
        goalId={goal.id}
        commitments={goal.commitments}
        archived={archived || ended}
      />
    </Panel>
  );

  const after = (
    <Panel>
      <Section>
        <Flex justify="between" align="center">
          {goal.phases.length > 0 ? (
            <SectionLabel>
              {t("goal.detail.phasesCount", {
                word: countWord(goal.phases.length, t, true),
                count: goal.phases.length,
              })}
            </SectionLabel>
          ) : null}
          {archived || ended ? null : (
            <Face on="desktop">
              <TextLink href={`/metas/${goal.id}/fases/nueva`}>
                {t("goal.phases.add")}
              </TextLink>
            </Face>
          )}
        </Flex>
        {goal.phases.map((phase) => (
          <Row
            key={phase.id}
            leading={
              <Mark
                state={currentPhase?.id === phase.id ? "declared" : "empty"}
                size="dot"
              />
            }
            name={phase.name}
            trailing={
              <Flex direction="column" align="end">
                <Text as="span" variant="sentence" tone="muted">
                  {phaseSpanLabel(openedOn, phase.startsOn, phase.endsOn, t)}
                </Text>
              </Flex>
            }
            href={archived || ended ? undefined : `/metas/${goal.id}/fases/${phase.id}`}
            disabled={archived || ended}
          />
        ))}
        {archived || ended ? null : (
          <Face on="phone">
            <Button asChild variant="outline" block>
              <Link href={`/metas/${goal.id}/fases/nueva`}>
                {t("goal.phases.add")}
              </Link>
            </Button>
          </Face>
        )}
      </Section>
    </Panel>
  );

  return (
    <Page width="full">
      <ScreenHeader
        chat
        title={goal.name}
        back={
          goal.parent
            ? { href: `/metas/${goal.parent.id}`, place: goal.parent.name }
            : { href: "/metas", place: t("common.nav.goals") }
        }
        metaVariant="sentence"
        meta={
          goal.level && !archived
            ? endLabel === null
              ? t("tree.goal.levelNoEnd", { level: levelName })
              : t("tree.goal.levelUntil", { level: levelName, date: endLabel })
            : t.rich(archived ? "goal.detail.archivedOverline" : "goal.detail.overline", {
                date: longDateLabel(goal.archivedAt ?? goal.createdAt),
                ...fig,
              })
        }
        actions={
          archived ? null : (
            <Face on="desktop">
              <Flex gap="3">
                <RenameGoalAction goalId={goal.id} name={goal.name} />
                <ArchiveGoalAction goalId={goal.id} name={goal.name} block={false} short {...archiveBranch} />
                {deleteAction(false)}
              </Flex>
            </Face>
          )
        }
      />
      {archived ? null : (
        <Face on="phone">
          <RenameGoalAction goalId={goal.id} name={goal.name} variant="outline" />
        </Face>
      )}

      {holds ? null : insideAction}

      <Split before={before} main={main} after={after} aside={380} afterBelow />

      {archived || ended ? null : (
        <MoveGoalAction goalId={goal.id} name={goal.name} tree={goal.tree} today={today} />
      )}
      <GoalNote goalId={goal.id} name={goal.name} note={goal.note} />

      {archived ? (
        <>
          <ReopenGoalButton goalId={goal.id} />
          {deleteAction(true)}
        </>
      ) : ended ? null : (
        <Face on="phone">
          <ArchiveGoalAction goalId={goal.id} name={goal.name} {...archiveBranch} />
          {deleteAction(true)}
        </Face>
      )}
    </Page>
  );
}
