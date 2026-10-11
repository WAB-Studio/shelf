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
import { dayWords } from "@/lib/day/day-words";
import { phaseOn } from "@/lib/day/derive";
import { partOf } from "@/lib/plan/months";
import { planHrefFrom } from "@/lib/plan/return-to";
import { planMonthList } from "@/lib/plan/roadmap-read";
import { loadGoal } from "@/lib/queries/goal";
import { dayBefore } from "@/lib/day/weeks";
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
import { MoveHorizonAction } from "./horizon-sheet";
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
  const endDay = dayBefore(goal.horizon);
  const endLabel = `${civilDayMonthShort(endDay)} ${endDay.slice(0, 4)}`;
  const openedOn = civilDateInZone(new Date(goal.createdAt));
  const totalWeeks = horizonWeeks(openedOn, goal.horizon);
  const currentPhase = phaseOn(goal.phases, today);

  const archived = goal.archivedAt !== null;
  const ended = goal.endedOn !== null && !archived;
  // An ended goal's sheet opens on the count that ends this Sunday.
  const sheetWeeks = ended
    ? Math.max(totalWeeks, weekIndex(openedOn, today))
    : totalWeeks;
  const moveAction = (
    <MoveHorizonAction
      goalId={goal.id}
      name={goal.name}
      openedOn={openedOn}
      horizon={goal.horizon}
      weeks={sheetWeeks}
      phases={goal.phases}
      reopening={ended}
    />
  );

  const phoneActs = ended ? (
    <Face on="phone">
      <Section as="div">
        {moveAction}
        <ArchiveGoalAction goalId={goal.id} name={goal.name} short />
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
  const lastDay = endDay < monthEnd ? endDay : monthEnd;
  const daysLeft = Math.round((Date.parse(`${lastDay}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
  const planned = month?.planned ?? null;
  const percent = month && planned ? Math.floor((month.reached * 100) / planned) : 0;
  // A goal with no measure has no amount to read, but its months and their
  // tasks stay reachable (`MetaSinMedida.dc.html`).
  const bareMonth = !goal.measureUnit && goal.months.some((row) => row.current);
  const monthKey = `${today.slice(0, 7)}-01`;
  const own = planMonthList(goal.plan, monthKey).filter((item) => item.carriedFrom === null);
  // An archived goal that holds no task this month has nothing to say of it;
  // «Ver por mes» is still the way to the months that do.
  const noMonthBlock = archived && bareMonth && own.length === 0;
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
    ? `${Number(planEnd.slice(8, 10))} de ${monthNames[Number(planEnd.slice(5, 7)) - 1]} de ${planEnd.slice(0, 4)}`
    : null;
  // A goal with no measure keeps its plan; one measured in something else has none.
  const measuresOther = goal.measureUnit !== null && !isTimeUnit(goal.measureUnit);
  const planSection =
    goal.roadmap.state === "empty" || measuresOther ? null : (
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
  const paceLine = planned !== null && planned > 0 && Boolean(month?.underPace) && goal.evidence !== "unreadable";
  const part = partOf(monthKey, goal.plan);
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
              t("goal.detail.monthNoPlan")
            )}
          </Text>
        )}
        {part ? (
          <Text as="p" variant="sentence" tone="muted">
            {t.rich("goal.detail.monthPart", {
              ...part,
              share: formatQuantity(part.share, goal.measureUnit ?? "", words),
              rhythm: formatQuantity(part.rhythm, goal.measureUnit ?? "", words),
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
                {ended ? t("goal.detail.monthProgressEnded", { percent }) : t("goal.detail.monthProgress", { percent, days: daysLeft })}
              </Text>
            )}
          </>
        ) : null}
        {measuresOther && planItems.length > 0 ? (
          <Text as="p" variant="line">
            {t("goal.detail.monthTasks", { done: planDone, total: planItems.length })}
          </Text>
        ) : null}
        {planned === null && !archived && !ended ? (
          <Button asChild variant="outline">
            <Link href={planHrefFrom(goal.id, today.slice(0, 7), `/metas/${goal.id}`)}>
              {t("goal.detail.monthPlanLink", { month: monthName })}
            </Link>
          </Button>
        ) : null}
      </Section>
    ) : null;

  const before = (
    <>
      {planSection}
      <Panel>
        <Face on="desktop">
          <SectionLabel>{t("goal.detail.endHeading")}</SectionLabel>
        </Face>
        {goal.endedOn ? (
          <Text as="p" variant="sentence">
            {endedOnWords(goal.endedOn, t)}
          </Text>
        ) : (
          <Flex justify="between" align="center">
            <Text as="p" variant="sentence" tone="muted">
              {t("goal.detail.horizonUntil", {
                weeks: totalWeeks,
                date: endLabel,
              })}
            </Text>
            {archived ? null : moveAction}
          </Flex>
        )}
        {goal.measureUnit ? null : (
          <Text as="p" variant="sentence" tone="muted">
            {t("month.list.noMeasure")}
          </Text>
        )}
        {ended ? <Face on="desktop">{moveAction}</Face> : null}
      </Panel>

      {goal.measureUnit ? (
        <Panel>
          <Text as="p" variant="sentence" tone="muted">
            {isTimeUnit(goal.measureUnit)
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
      )}
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
            disabled
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
        title={goal.name}
        back={{ href: "/metas", place: t("common.nav.goals") }}
        metaVariant="sentence"
        meta={t.rich(archived ? "goal.detail.archivedOverline" : "goal.detail.overline", {
          date: longDateLabel(goal.archivedAt ?? goal.createdAt),
          ...fig,
        })}
        actions={
          archived ? null : (
            <Face on="desktop">
              <Flex gap="3">
                <RenameGoalAction goalId={goal.id} name={goal.name} />
                <ArchiveGoalAction goalId={goal.id} name={goal.name} block={false} short />
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

      <Split before={before} main={main} after={after} aside={380} afterBelow />

      {archived ? (
        <ReopenGoalButton goalId={goal.id} />
      ) : ended ? null : (
        <Face on="phone">
          <ArchiveGoalAction goalId={goal.id} name={goal.name} />
        </Face>
      )}
    </Page>
  );
}
