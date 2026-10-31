import Link from "next/link";
import { Fragment, type ReactNode } from "react";
import { getTranslations } from "next-intl/server";

import { Button, Face, Figure, Flex, Hero, Page, Panel, Progress, Section, SectionLabel, Split, Text, TextLink } from "@/components/ui";
import type { Translator } from "@/i18n/translator";
import { dayPhrase as dayPhraseOf, endedPhrase, type DayPhraseKey } from "@/lib/day/day-phrase";
import { sentenceCase } from "@/lib/day/day-words";
import { metPhrase, phaseLine } from "@/lib/day/row-phrases";
import { tallyDay, tallyDays } from "@/lib/day/tally";
import { phaseOn } from "@/lib/day/derive";
import type { DaySlot } from "@/lib/day/types";
import { loadWeek } from "@/lib/queries/week";
import { loadDay, type CommitmentInfo, type OneOffSummary } from "@/lib/queries/day";
import { PAST_DAY_LIMIT } from "@/lib/validation/fact";
import { civilDateToDate, dateToCivilDate, timeInZone, todayInZone } from "@/lib/zone";

import { DayHeader } from "./day-header";
import { DayRow } from "./day-row";
import { EmptyDay } from "./empty-day";
import { DoneOneOffRow } from "./done-one-off-row";
import { EvidenceNote } from "./evidence-note";
import type { SourceKey } from "@/i18n/translator";
import { screenPlanned } from "@/lib/plan/screen-planned";
import type { DayMonthLine } from "@/lib/queries/day";
import { evidenceUnitWords } from "@/lib/evidence/unit-words";
import { NewOneOff } from "./new-one-off";
import { MonthTaskLine } from "./month-task-line";
import { OneOffRow } from "./one-off-row";
import { PlanNotices, type PlanNoticeItem } from "./plan-notice";


// Goes through `Date` and back rather than subtracting on the string: a
// civil date crosses months and years, and a digit subtraction does not.
export function shiftCivilDay(day: string, days: number): string {
  const date = civilDateToDate(day);
  date.setUTCDate(date.getUTCDate() + days);
  return dateToCivilDate(date);
}

// The oldest day a fact may still name (RP-06): `/dia/[fecha]` refuses any
// day before it, and its own screen draws no step back from it.
export function oldestPastDay(today: string): string {
  return shiftCivilDay(today, -PAST_DAY_LIMIT);
}

// RP-76: the query keeps the 0; the screen reads it as a month with no amount.
function screenPlannedOf(line: DayMonthLine | undefined): number | null {
  return line === undefined ? null : screenPlanned(line.planned, line.ownBudget);
}

// Monday first, as `day.weekdayLong` lists them; `getUTCDay` is 0 for Sunday.
function weekdayOf(day: string, t: Translator): string {
  const names = t.raw("day.weekdayLong") as string[];
  return names[(civilDateToDate(day).getUTCDay() + 6) % 7];
}

// «sábado 26 de septiembre»: the header's own date.
function dateLabel(day: string, t: Translator): string {
  const date = civilDateToDate(day);
  const months = t.raw("day.monthLong") as string[];
  return t("day.date", {
    weekday: weekdayOf(day, t),
    day: date.getUTCDate(),
    month: months[date.getUTCMonth()],
  });
}

function dayPhrase(key: DayPhraseKey, day: string, t: Translator, extra: Record<string, string> = {}): string {
  return dayPhraseOf(
    (phraseKey, values) => t(phraseKey, values),
    key,
    day,
    todayInZone(),
    { weekdays: t.raw("day.weekdayLong") as string[], months: t.raw("day.monthLong") as string[] },
    extra,
  );
}

/**
 * Opens the app on today (RP-01): no tap, no choice, no screen before it —
 * `app/page.tsx` is the redirect gate and nothing else, this is the whole
 * screen.
 *
 * Every open goal draws as its own group, in one scroll, with no selector
 * (§0.3, 5): `loadDay`'s `commitments` names which goal each slot belongs
 * to, and `phases` — narrowed to that goal — decides the phase in effect
 * through `phaseOn`, called once per goal rather
 * than reading `view.phase`, which picks a single span across every goal at
 * once and is only ever right for one of them.
 *
 * A one-off draws under the goal it belongs to (RP-19, RP-20): its own row
 * inside that goal's section, with that goal's own field to write another
 * one the same way. A one-off that belongs to nothing draws in its own
 * "Sueltas" group below the last goal, with the field that writes one of
 * those — permanently visible either way, never behind a control that
 * reveals it (`one-off-row.tsx`, `new-one-off.tsx`). A one-off undone since
 * an earlier day rides first, naming the day it was meant for.
 *
 * Given a `day` before today (RP-06, `/dia/[fecha]`), the same rows draw
 * for that day and every fact they write names it. The dated one-offs it
 * still owed draw too, and those done on it, tapped as on Hoy (RP-129); a
 * month task with no day, the field and «Darle otro día» stay on Hoy.
 */
export async function DayScreen({ day: requested }: { day?: string } = {}) {
  const t = await getTranslations();
  // «3 búsquedas»: the number and the source's noun, each through next-intl.
  const evidenceAmount = (evidence: { labelKey: SourceKey }, count: number) =>
    t("day.row.evidenceAmount", { count, unit: evidenceUnitWords({ labelKey: evidence.labelKey, unit: "" }, count, t) });
  const today = todayInZone();
  const day = requested ?? today;
  const past = day < today;
  // The week rides beside the day, for the seven marks in the navy block (never after it, RNP-03).
  const [loaded, week] = await Promise.all([loadDay(day), past ? null : loadWeek(day, today)]);
  const {
    view,
    evidence,
    goals: openGoals,
    oneOffs,
    doneOneOffs,
    daylessCount,
    scheduledCount,
    weekMeasure,
    commitments,
    phases,
    phasePositions,
    factsByCommitment,
    periodDone,
  } = loaded;

  // A goal opened after the day drawn did not exist on it: it is not drawn
  // there at all (RNP-07).
  const goals = openGoals.filter((goal) => goal.openedOn <= day);
  const laterGoal = past
    ? openGoals.filter((goal) => goal.openedOn > day).sort((a, b) => a.openedOn.localeCompare(b.openedOn))[0]
    : undefined;

  // Every goal ended and none open (`HoyTodasTerminadas.dc.html`).
  const lastEnded = !past && openGoals.length === 0 ? loaded.lastEnded : null;

  // Only today, and only while some goal is open: the all-ended card already
  // names the last one (`HoyMetaTerminada.dc.html`).
  const endedLines =
    past || openGoals.length === 0
      ? []
      : loaded.endedThisWeek.map((goal) => ({
          id: goal.id,
          text: endedPhrase(
            (key, values) => t(key, values),
            goal.name,
            goal.lastDay,
            todayInZone(),
            { weekdays: t.raw("day.weekdayLong") as string[], months: t.raw("day.monthLong") as string[] },
          ),
          href: `/metas/${goal.id}`,
          see: t("day.ended.see"),
          seeLabel: t("day.ended.seeLabel", { goal: goal.name }),
        }));

  const waiting = daylessCount + scheduledCount;

  // The same count the Semana's cell for this day makes; nothing to say when
  // it counts nothing or when the all-ended card stands in for the goals.
  const counted = tallyDay({ view, goals: openGoals, commitments });
  // The tally's figures in mono, each word between them in the line's own Archivo.
  const fig = { fig: (chunks: ReactNode) => <Figure variant="meta" value={chunks} /> };
  const tally =
    lastEnded || counted.total === 0
      ? undefined
      : counted.partial > 0
        ? t.rich("day.tallyPartial", { done: counted.done, total: counted.total, partial: counted.partial, ...fig })
        : t.rich("day.tally", { done: counted.done, total: counted.total, ...fig });
  const weekShort = t.raw("day.cadence.weekdayName") as string[];
  const weekDays = week
    ? tallyDays(week).map((tally, index) => ({
        key: tally.day,
        label: weekShort[index],
        name: `${weekdayOf(tally.day, t)} ${Number(tally.day.slice(8, 10))}`,
        today: tally.day === today,
        figure: tally.total === 0 || tally.day > today ? undefined : `${tally.done}/${tally.total}`,
        state:
          tally.total === 0 || tally.day > today
            ? ("none" as const)
            : tally.done >= tally.total
              ? ("declared" as const)
              : tally.done > 0 || tally.partial > 0
                ? ("partial" as const)
                : ("empty" as const),
      }))
    : undefined;
  // Today's one navy block: how many of what the day asks are done, and the bar of it.
  const hero =
    past || lastEnded || counted.total === 0 ? null : (
      <Hero
        label={t("day.hero.label")}
        figure={t("day.hero.figure", { done: counted.done, total: counted.total })}
        caption={counted.partial > 0 ? t("day.hero.captionPartial", { partial: counted.partial }) : t("day.hero.caption")}
        highlight
        days={weekDays}
      >
        <Progress percent={Math.floor((counted.done * 100) / counted.total)} />
      </Hero>
    );
  const slotByCommitmentId = new Map(view.slots.map((slot) => [slot.commitmentId, slot]));

  // Stable: within each kind, `loadDay`'s own creation order stands.
  const carriedFirst = [...oneOffs].sort(
    (a, b) => Number(!isCarried(a, day)) - Number(!isCarried(b, day)),
  );

  function noteEyebrow(goalId: string | null) {
    const goal = goals.find((candidate) => candidate.id === goalId);
    return goal ? t("oneOffs.note.eyebrowGoal", { goal: goal.name }) : t("oneOffs.note.eyebrowLoose");
  }

  function goalNameOf(goalId: string | null) {
    return goals.find((candidate) => candidate.id === goalId)?.name;
  }

  function oneOffRow(oneOff: OneOffSummary) {
    return (
      <OneOffRow
        key={oneOff.id}
        oneOffId={oneOff.id}
        name={oneOff.name}
        day={oneOff.day ?? day}
        note={oneOff.note}
        noteEyebrow={noteEyebrow(oneOff.goalId)}
        goalName={goalNameOf(oneOff.goalId)}
        doneOn={past ? day : undefined}
        carriedFrom={
          isCarried(oneOff, day)
            ? dayPhrase("day.oneOffs.carriedFrom", oneOff.day, t)
            : undefined
        }
      />
    );
  }

  // The goals that ask today first, each group in `loadDay`'s order. A quiet
  // met row asks nothing; a pending one-off of the goal does.
  const sections = goals
    .map((goal) => {
      const own = commitments
        .filter((commitment) => commitment.goalId === goal.id)
        .map((commitment) => ({ commitment, slot: slotByCommitmentId.get(commitment.id) }));
      // A commitment that does not ask on `day` has no slot at all
      // (`deriveDay`'s own contract): one still owed draws nothing, one
      // already met in its period draws quiet after the asked rows.
      const rows = own.filter(
        (entry): entry is { commitment: CommitmentInfo; slot: DaySlot } => entry.slot !== undefined,
      );
      const met = own
        .filter(
          (entry) =>
            entry.slot === undefined &&
            metPhrase((key, values) => t(key, values), {
              cadence: entry.commitment.cadence,
              periodDone: periodDone[entry.commitment.id],
            }) !== null,
        )
        .map((entry) => entry.commitment);
      const asks = rows.length > 0 || oneOffs.some((oneOff) => oneOff.goalId === goal.id);
      return { goal, rows, met, asks };
    })
    // A past day draws no goal that had no row, no met row and no task owed.
    .filter(({ met, asks }) => !past || asks || met.length > 0)
    .sort((a, b) => Number(!a.asks) - Number(!b.asks));

  type SectionItem = (typeof sections)[number];

  // Habits with no goal (RP-100): the same rows, in a group of their own after the goals.
  const looseOwn = commitments
    .filter((commitment) => commitment.goalId === null)
    .map((commitment) => ({ commitment, slot: slotByCommitmentId.get(commitment.id) }));
  const looseRows = looseOwn.filter(
    (entry): entry is { commitment: CommitmentInfo; slot: DaySlot } => entry.slot !== undefined,
  );
  const looseMet = looseOwn
    .filter(
      (entry) =>
        entry.slot === undefined &&
        metPhrase((key, values) => t(key, values), {
          cadence: entry.commitment.cadence,
          periodDone: periodDone[entry.commitment.id],
        }) !== null,
    )
    .map((entry) => entry.commitment);
  const habitsGroup =
    looseRows.length > 0 || looseMet.length > 0 ? (
      <Panel as="div">
        <Section label={t("day.habits.title")}>
          <Flex direction="column">{commitmentRows(looseRows, looseMet, undefined)}</Flex>
        </Section>
      </Panel>
    ) : null;

  // `naming` is the goal a row of a large or a small goal names; the
  // general's own rows and a loose goal's name nothing.
  function itemBody(item: SectionItem, naming: string | undefined) {
    const { goal, rows, met } = item;
    const goalPhase = phaseOn(
      phases.filter((phase) => phase.goalId === goal.id),
      day,
    );
    return (
      <>
        {goalPhase ? (
          <Text as="p" variant="sentence">
            {phaseLine((key, values) => t(key, values), goalPhase.name, phasePositions[goalPhase.id])}
          </Text>
        ) : null}
        {commitmentRows(rows, met, naming)}
      </>
    );
  }

  function commitmentRows(
    rows: { commitment: CommitmentInfo; slot: DaySlot }[],
    met: CommitmentInfo[],
    naming: string | undefined,
  ) {
    return (
      <>
        {rows.map(({ commitment, slot }) => {
          const logged = factsByCommitment[commitment.id];
          return (
            <DayRow
              key={commitment.id}
              commitmentId={commitment.id}
              name={commitment.name}
              goalName={naming}
              kind={commitment.kind}
              markState={
                slot.satisfiedBy === "evidence"
                  ? "evidence"
                  : slot.satisfied
                    ? "declared"
                    : slot.partial
                      ? "partial"
                      : "empty"
              }
              evidence={
                commitment.evidence
                  ? {
                      asks:
                        evidence === "unreadable"
                          ? t("day.row.unreadSourceAsks", { asks: evidenceAmount(commitment.evidence, commitment.evidence.threshold) })
                          : evidenceAmount(commitment.evidence, commitment.evidence.threshold),
                      got:
                        slot.satisfiedBy === "evidence"
                          ? evidenceAmount(commitment.evidence, slot.quantity ?? 0)
                          : null,
                      source: evidence === "unreadable" ? null : t(commitment.evidence.labelKey),
                    }
                  : undefined
              }
              quiet={evidence === "unreadable" && Boolean(commitment.evidence)}
              target={commitment.target}
              unit={commitment.unit}
              cadence={commitment.cadence}
              periodDone={periodDone[commitment.id]}
              factId={logged?.factId}
              loggedQuantity={logged?.quantity ?? null}
              note={logged?.note ?? null}
              day={past ? day : undefined}
              drawnToday={past ? undefined : day}
              writtenLabel={
                logged && logged.writtenOn !== day
                  ? dayPhrase("day.past.writtenOn", logged.writtenOn, t)
                  : undefined
              }
              writtenTime={
                logged && slot.satisfiedBy !== "evidence" && (slot.satisfied || commitment.kind === "quantity")
                  ? timeInZone(logged.writtenAt)
                  : undefined
              }
            />
          );
        })}
        {met.map((commitment) => {
          const logged = factsByCommitment[commitment.id];
          return (
            <DayRow
              key={commitment.id}
              commitmentId={commitment.id}
              name={commitment.name}
              goalName={naming}
              kind={commitment.kind}
              markState="declared"
              quiet
              target={commitment.target}
              unit={commitment.unit}
              cadence={commitment.cadence}
              periodDone={periodDone[commitment.id]}
              factId={logged?.factId}
              loggedQuantity={logged?.quantity ?? null}
              note={logged?.note ?? null}
              day={past ? day : undefined}
              drawnToday={past ? undefined : day}
            />
          );
        })}
      </>
    );
  }

  // Groups in tree order; the ones that ask today first.
  const groupBlocks = loaded.groups
    .map((group) => {
      const items = group.goalIds
        .map((id) => sections.find((item) => item.goal.id === id))
        .filter((item): item is SectionItem => item !== undefined);
      const rootGoal = openGoals.find((goal) => goal.id === group.rootId);
      return {
        rootId: group.rootId,
        items,
        asks: items.some((item) => item.asks),
        tree: rootGoal?.level != null,
      };
    })
    .filter((block) => block.items.length > 0)
    .sort((a, b) => Number(!a.asks) - Number(!b.asks));
  // A goal whose month line stands in its asking block; the rest keep the
  // flat «este mes» lines below.
  const embedded = new Set(
    groupBlocks.filter((block) => block.tree && block.asks && !past).flatMap((block) => block.items.map((item) => item.goal.id)),
  );

  // One card per open goal that has a measure; the rest get one only for «este mes».
  const figures = goals.filter(
    (goal) => goal.measureName !== null && weekMeasure[goal.id] !== undefined && !embedded.has(goal.id),
  );

  // Drawn inside `goalless`, so only on today (RP-28), never on a past day.
  // A goal with no amount and no task this month draws nothing; one with
  // tasks draws its line measured or not.
  const monthGoals = goals.filter(
    (goal) =>
      (goal.measureUnit !== null && screenPlannedOf(loaded.monthLine[goal.id]) !== null) ||
      loaded.monthTaskCounts[goal.id] !== undefined,
  );

  // The same two lines on the phone block and in the desktop card: reached
  // «de» planned, and from the 20th the pace in ink, never an alarm.
  const monthLines = (goal: (typeof goals)[number]) => {
    const line = loaded.monthLine[goal.id];
    const planned = screenPlannedOf(line);
    const counts = loaded.monthTaskCounts[goal.id];
    return (
      <>
        {line === undefined || planned === null ? (
          // No amount planned: the reached figure when the goal measures,
          // then its tasks done of total (a measureless goal reads only those).
          <Flex align="baseline" gap="2" wrap="wrap">
            {line !== undefined ? (
              <>
                <Figure value={line.reached} unit={goal.measureUnit ?? undefined} variant="meta" />
                <Text variant="sentence">
                  {t("day.monthLine.tasksAfterFigure", { done: counts.done, total: counts.total })}
                </Text>
              </>
            ) : (
              <>
                <Figure value={counts.done} variant="meta" />
                <Text variant="sentence">
                  {t("day.monthLine.tasksOf", { total: counts.total })}
                </Text>
              </>
            )}
          </Flex>
        ) : line.underPace ? (
          // The unit is said once, after «de».
          <Text as="p" variant="sentence">
            {t("day.monthLine.pace", { day: Number(day.slice(8, 10)) })}{" "}
            <Figure value={line.reached} unit={goal.measureUnit ?? undefined} variant="meta" bare />{" "}
            {t("day.monthLine.of")} <Figure value={planned} unit={goal.measureUnit ?? undefined} variant="meta" />
            {t("day.monthLine.paceUnder", { threshold: 60 })}
          </Text>
        ) : (
          <Flex align="baseline" gap="2" wrap="wrap">
            <Figure value={line.reached} unit={goal.measureUnit ?? undefined} variant="meta" bare />
            <Text variant="sentence">
              {t("day.monthLine.of")} <Figure value={planned} unit={goal.measureUnit ?? undefined} variant="meta" />
            </Text>
          </Flex>
        )}
        {taskLine(goal)}
      </>
    );
  };

  const taskLine = (goal: (typeof goals)[number]) => {
    const task = loaded.monthTask[goal.id];
    return task ? (
      <MonthTaskLine
        key={task.id}
        oneOffId={task.id}
        name={task.name}
        estimate={task.estimate}
        unit={goal.measureUnit ?? ""}
        parentName={task.parentName}
        part={task.part}
        note={task.note}
        noteEyebrow={noteEyebrow(goal.id)}
      />
    ) : null;
  };

  // A goal's month inside its group's block: the month and the sum for the
  // general, the goal's name above its own line for a large or a small one.
  const embeddedMonth = (goal: (typeof goals)[number], naming: boolean) => {
    if (!monthGoals.includes(goal)) return null;
    const line = loaded.monthLine[goal.id];
    const planned = screenPlannedOf(line);
    return (
      <Flex key={`month-${goal.id}`} direction="column" gap="2">
        {naming ? (
          <Text as="p" variant="name">
            {goal.name}
          </Text>
        ) : null}
        {line !== undefined && planned !== null ? (
          <>
            <Text as="p" variant="sentence">
              {(t.raw("day.monthLong") as string[])[Number(day.slice(5, 7)) - 1]} ·{" "}
              <Figure value={line.reached} unit={goal.measureUnit ?? undefined} variant="meta" bare />{" "}
              {t("day.monthLine.of")} <Figure value={planned} unit={goal.measureUnit ?? undefined} variant="meta" />
            </Text>
            {taskLine(goal)}
          </>
        ) : (
          monthLines(goal)
        )}
      </Flex>
    );
  };

  // One block, so the past day's two columns never split the title from its line.
  const goalsMain = past && sections.length === 0 && !habitsGroup && oneOffs.length === 0 && doneOneOffs.length === 0 ? (
    <Flex direction="column" gap="2">
      <Text as="p" variant="title">
        {t("day.past.nothingTitle")}
      </Text>
      {goals.length === 0 && laterGoal ? (
        <Text as="p" variant="sentence">
          {dayPhrase("day.past.startedOn", laterGoal.openedOn, t, { goal: laterGoal.name })}
        </Text>
      ) : null}
    </Flex>
  ) : lastEnded ? (
    <Panel as="div">
      {oneOffs.length === 0 ? (
        <Text as="p" variant="title" plainWide>
          {t("day.allEnded.title")}
        </Text>
      ) : null}
      <Text as="p">
        {t("day.allEnded.body", {
          goal: lastEnded.name,
          date: dateLabel(shiftCivilDay(lastEnded.horizon, -1), t),
          year: shiftCivilDay(lastEnded.horizon, -1).slice(0, 4),
        })}
      </Text>
      <Button asChild block>
        <Link href="/metas">{t("day.allEnded.toGoals")}</Link>
      </Button>
      <Button asChild block variant="outline">
        <Link href="/metas/nueva">{t("day.allEnded.newGoal")}</Link>
      </Button>
    </Panel>
  ) : goals.length === 0 ? (
    habitsGroup || past ? null : <EmptyDay />
  ) : (
    <>
      {groupBlocks.map(({ rootId, items, asks, tree }) => {
        const root = items[0].goal.id === rootId ? items[0].goal : openGoals.find((goal) => goal.id === rootId);
        const asked = items.reduce((total, item) => total + item.rows.length, 0);
        const label =
          past && asked > 0
            ? t("day.past.asked", { goal: root?.name ?? "", count: (t.raw("day.past.askedWords") as string[])[asked] ?? asked })
            : (root?.name ?? "");
        const block = (
          <Panel as="div" key={rootId}>
            <Section label={label}>
              <Flex direction="column">
                {tree && root && !past ? embeddedMonth(root, false) : null}
                {items.map((item) => (
                  <Fragment key={item.goal.id}>
                    {itemBody(item, tree && item.goal.id !== rootId ? item.goal.name : undefined)}
                    {carriedFirst.filter((oneOff) => oneOff.goalId === item.goal.id).map(oneOffRow)}
                    {tree && !past && item.goal.id !== rootId ? embeddedMonth(item.goal, true) : null}
                  </Fragment>
                ))}
                {past || !root ? null : (
                  <Face on="desktop">
                    <NewOneOff goalId={root.id} daylessCount={daylessCount} goalName={root.name} />
                  </Face>
                )}
              </Flex>
            </Section>
          </Panel>
        );
        // A group that asks nothing today has no block on the phone; its
        // «este mes» line is drawn elsewhere (`HoyTelefonoSinPedido.dc.html`).
        return asks ? block : <Face on="desktop" key={rootId}>{block}</Face>;
      })}
    </>
  );

  // A one-off belonging to nothing (RP-20) has no goal section to draw
  // under, so it gets a group of its own — always on screen, even with
  // no goal open yet, because RP-19 asks for no goal behind it either.
  const phoneMonthGoals = monthGoals.filter((goal) => !embedded.has(goal.id));
  const looseTasks = carriedFirst.filter((oneOff) => oneOff.goalId === null);
  const doneBlock =
    doneOneOffs.length > 0 ? (
      <Panel as="div">
        <Section label={t(past ? "day.doneOneOffs.titlePast" : "day.doneOneOffs.title")}>
          <Flex direction="column">
            {doneOneOffs.map((done) => (
              <DoneOneOffRow
                key={done.id}
                factId={done.factId}
                name={done.name}
                oneOffId={done.id}
                note={done.note}
                noteEyebrow={noteEyebrow(done.goalId)}
                goalName={goalNameOf(done.goalId)}
                time={timeInZone(done.writtenAt)}
              />
            ))}
          </Flex>
        </Section>
      </Panel>
    ) : null;
  // A past day: the goal-less tasks it owed, with no field and no link to the
  // ones that wait, then what was done on it. Month tasks stay on Hoy.
  const pastTasks = (
    <>
      {looseTasks.length > 0 ? (
        <Panel as="div">
          <Section label={t("day.oneOffs.title")}>
            <Flex direction="column">{looseTasks.map(oneOffRow)}</Flex>
          </Section>
        </Panel>
      ) : null}
      {doneBlock}
    </>
  );
  const goalless = past ? pastTasks : (
    <>
      {figures.map((goal) => (
        <Panel as="div" key={goal.id}>
          <Face on="desktop">
            <Flex direction="column" gap="4">
              <Section label={goal.name}>
                <Flex align="baseline" gap="2">
                  <Figure variant="big" value={weekMeasure[goal.id]} unit={goal.measureUnit ?? undefined} />
                  <Text variant="sentence">{t("day.weekFigure.caption")}</Text>
                </Flex>
              </Section>
              {monthGoals.includes(goal) ? (
                <Section label={t("day.monthLine.title")}>{monthLines(goal)}</Section>
              ) : null}
              <TextLink href={`/metas/${goal.id}/revision`}>{t("goal.detail.reviewLink")}</TextLink>
            </Flex>
          </Face>
        </Panel>
      ))}
      {monthGoals
        .filter((goal) => !figures.includes(goal) && !embedded.has(goal.id))
        .map((goal) => (
          <Panel as="div" key={goal.id}>
            <Face on="desktop">
              <Section label={goal.name}>
                <Text variant="sentence">{t("day.monthLine.title")}</Text>
                {monthLines(goal)}
              </Section>
            </Face>
          </Panel>
        ))}
      {phoneMonthGoals.length > 0 ? (
        <Face on="phone">
          <Panel as="div">
            <Section label={t("day.monthLine.title")}>
              <Flex direction="column" gap="6">
                {phoneMonthGoals.map((goal) => (
                  <Flex key={goal.id} direction="column" gap="2">
                    <Text as="p" variant="name">
                      {goal.name}
                    </Text>
                    {monthLines(goal)}
                  </Flex>
                ))}
              </Flex>
            </Section>
          </Panel>
        </Face>
      ) : null}
      <Panel as="div">
        <Section>
          <Flex justify="between" align="center" gap="2">
            <SectionLabel>{t("day.oneOffs.title")}</SectionLabel>
            {waiting > 0 ? (
              <TextLink href="/sueltas">{t("day.oneOffs.daylessLink", { count: waiting })}</TextLink>
            ) : null}
          </Flex>
          <Flex direction="column">
            {looseTasks.map(oneOffRow)}
            <Face on="desktop">
              <NewOneOff daylessCount={daylessCount} />
            </Face>
            <Face on="phone">
              <NewOneOff
                daylessCount={daylessCount}
                chooseGoal={groupBlocks.flatMap(({ rootId, items }) => {
                  const root = items[0].goal.id === rootId ? items[0].goal : openGoals.find((goal) => goal.id === rootId);
                  return root ? [{ id: root.id, name: root.name }] : [];
                })}
              />
            </Face>
          </Flex>
        </Section>
      </Panel>
      {doneBlock}
    </>
  );

  const monthNames = t.raw("day.monthLong") as string[];
  const noticeItems: PlanNoticeItem[] = [];
  if (!past) {
    for (const goal of goals) {
      const notice = loaded.planNotice[goal.id];
      if (!notice) continue;
      const end = civilDateToDate(notice.end);
      noticeItems.push({
        goalId: goal.id,
        goalName: goal.name,
        unit: goal.measureUnit ?? "",
        notice,
        closedMonthName: monthNames[Number(notice.closedMonth.slice(5, 7)) - 1],
        nextMonthName: monthNames[Number(notice.closedMonth.slice(5, 7)) % 12],
        endDay: end.getUTCDate(),
        endMonthName: monthNames[end.getUTCMonth()],
        endYear: end.getUTCFullYear(),
      });
    }
  }
  const notices = past ? null : <PlanNotices notices={noticeItems} />;

  return (
    <Page width="full">
      {past ? (
        <DayHeader
          date={sentenceCase(dateLabel(day, t))}
          forward={{
            href: shiftCivilDay(day, 1) === today ? "/" : `/dia/${shiftCivilDay(day, 1)}`,
            label: t("day.nav.dayAfter"),
          }}
          back={
            day > oldestPastDay(today)
              ? { href: `/dia/${shiftCivilDay(day, -1)}`, label: t("day.nav.dayBefore") }
              : undefined
          }
          limitNote={day > oldestPastDay(today) ? undefined : t("day.past.limit")}
          toToday={{ href: "/", label: t("day.nav.today") }}
          tally={tally}
        />
      ) : (
        <DayHeader
          date={sentenceCase(dateLabel(day, t))}
          title={t("day.title")}
          back={
            loaded.firstGoalDay !== null && shiftCivilDay(day, -1) >= loaded.firstGoalDay
              ? { href: `/dia/${shiftCivilDay(day, -1)}`, label: t("day.nav.yesterday") }
              : undefined
          }
          theme={{ toLightLabel: t("day.theme.toLight"), toDarkLabel: t("day.theme.toDark") }}
          ended={endedLines}
        />
      )}
      {hero}

      {evidence === "unreadable" ? (
        <EvidenceNote title={t("day.unreadableTitle")} body={t("day.unreadableBody")} />
      ) : null}

      <Split main={<>{notices}{goalsMain}{habitsGroup}</>} after={goalless} even={past} />
    </Page>
  );
}

// A one-off meant for a day before the one drawn, still undone (RP-19):
// `loadDay` carries it with its own `day`, never clamped to today's.
function isCarried(oneOff: OneOffSummary, day: string): oneOff is OneOffSummary & { day: string } {
  return oneOff.day !== null && oneOff.day < day;
}
