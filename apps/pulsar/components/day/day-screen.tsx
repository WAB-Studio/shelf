import Link from "next/link";
import type { ReactNode } from "react";
import { getTranslations } from "next-intl/server";

import { Button, Face, Figure, Flex, Page, Panel, Section, SectionLabel, Split, Text, TextLink } from "@/components/ui";
import type { Translator } from "@/i18n/translator";
import { dayPhrase as dayPhraseOf, endedPhrase, type DayPhraseKey } from "@/lib/day/day-phrase";
import { metPhrase, phaseLine } from "@/lib/day/row-phrases";
import { tallyDay } from "@/lib/day/tally";
import { phaseOn } from "@/lib/day/derive";
import type { DaySlot } from "@/lib/day/types";
import { loadDay, type CommitmentInfo, type OneOffSummary } from "@/lib/queries/day";
import { PAST_DAY_LIMIT } from "@/lib/validation/fact";
import { civilDateToDate, dateToCivilDate, timeInZone, todayInZone } from "@/lib/zone";

import { DayHeader } from "./day-header";
import { DayRow } from "./day-row";
import { EmptyDay } from "./empty-day";
import { DoneOneOffRow } from "./done-one-off-row";
import { EvidenceNote } from "./evidence-note";
import type { SourceKey } from "@/i18n/translator";
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
 * for that day and every fact they write names it. No one-off draws there:
 * an undone one already rides today, and a one-off is done the day it is
 * done (`requireDayForSubject`).
 */
export async function DayScreen({ day: requested }: { day?: string } = {}) {
  const t = await getTranslations();
  // «3 búsquedas»: the number and the source's noun, each through next-intl.
  const evidenceAmount = (evidence: { labelKey: SourceKey }, count: number) =>
    t("day.row.evidenceAmount", { count, unit: evidenceUnitWords({ labelKey: evidence.labelKey, unit: "" }, count, t) });
  const today = todayInZone();
  const day = requested ?? today;
  const past = day < today;
  const loaded = await loadDay(day);
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
    goals.length === 0 || lastEnded || counted.total === 0
      ? undefined
      : counted.partial > 0
        ? t.rich("day.tallyPartial", { done: counted.done, total: counted.total, partial: counted.partial, ...fig })
        : t.rich("day.tally", { done: counted.done, total: counted.total, ...fig });
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
      const asks = rows.length > 0 || (!past && oneOffs.some((oneOff) => oneOff.goalId === goal.id));
      return { goal, rows, met, asks };
    })
    // A past day draws no goal that had no row and no met row.
    .filter(({ rows, met }) => !past || rows.length > 0 || met.length > 0)
    .sort((a, b) => Number(!a.asks) - Number(!b.asks));

  // One block, so the past day's two columns never split the title from its line.
  const goalsMain = past && sections.length === 0 ? (
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
    <EmptyDay />
  ) : (
    <>
      {sections.map(({ goal, rows, met, asks }) => {
        const goalPhases = phases.filter((phase) => phase.goalId === goal.id);
        const goalPhase = phaseOn(goalPhases, day);

        // What «hechos» counts: every row that asks that day.
        const asked = rows.length;

        const section = (
          <Panel as="div" key={goal.id}>
            <Section
              label={
                past && asked > 0
                  ? t("day.past.asked", {
                      goal: goal.name,
                      count: (t.raw("day.past.askedWords") as string[])[asked] ?? asked,
                    })
                  : goal.name
              }
            >
              <Flex direction="column">
                {goalPhase ? (
                  <Text as="p" variant="sentence">
                    {phaseLine((key, values) => t(key, values), goalPhase.name, phasePositions[goalPhase.id])}
                  </Text>
                ) : null}
                {rows.map(({ commitment, slot }) => {
                  const logged = factsByCommitment[commitment.id];
                  return (
                    <DayRow
                      key={commitment.id}
                      commitmentId={commitment.id}
                      name={commitment.name}
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
                              source: slot.satisfiedBy === "evidence" ? t(commitment.evidence.labelKey) : null,
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
                    />
                  );
                })}
                {past ? null : (
                  <>
                    {carriedFirst.filter((oneOff) => oneOff.goalId === goal.id).map(oneOffRow)}
                    <NewOneOff goalId={goal.id} daylessCount={daylessCount} goalName={goal.name} />
                  </>
                )}
              </Flex>
            </Section>
          </Panel>
        );
        // A goal that asks nothing today has no section on the phone; its
        // «este mes» line is drawn elsewhere (`HoyTelefonoSinPedido.dc.html`).
        return asks ? section : <Face on="desktop" key={goal.id}>{section}</Face>;
      })}
    </>
  );

  // One card per open goal that has a measure; the rest get one only for «este mes».
  const figures = goals.filter((goal) => goal.measureName !== null && weekMeasure[goal.id] !== undefined);

  // Drawn inside `goalless`, so only on today (RP-28), never on a past day.
  // A goal with no amount and no task this month draws nothing; one with
  // tasks draws its line measured or not.
  const monthGoals = goals.filter(
    (goal) =>
      (goal.measureUnit !== null && loaded.monthLine[goal.id]?.planned != null) ||
      loaded.monthTaskCounts[goal.id] !== undefined,
  );

  // The same two lines on the phone block and in the desktop card: reached
  // «de» planned, and from the 20th the pace in ink, never an alarm.
  const monthLines = (goal: (typeof goals)[number]) => {
    const line = loaded.monthLine[goal.id];
    const planned = line?.planned ?? null;
    const counts = loaded.monthTaskCounts[goal.id];
    const task = loaded.monthTask[goal.id];
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
        {task ? (
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
        ) : null}
      </>
    );
  };

  // A one-off belonging to nothing (RP-20) has no goal section to draw
  // under, so it gets a group of its own — always on screen, even with
  // no goal open yet, because RP-19 asks for no goal behind it either.
  const goalless = past ? undefined : (
    <>
      {figures.map((goal) => (
        <Panel as="div" key={goal.id}>
          <Face on="desktop">
            <Flex direction="column" gap={{ initial: "6", lg: "7" }}>
              <Section label={goal.name}>
                <Flex align="baseline" gap="2">
                  <Figure value={weekMeasure[goal.id]} unit={goal.measureUnit ?? undefined} />
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
        .filter((goal) => !figures.includes(goal))
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
      {monthGoals.length > 0 ? (
        <Face on="phone">
          <Panel as="div">
            <Section label={t("day.monthLine.title")}>
              <Flex direction="column" gap="6">
                {monthGoals.map((goal) => (
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
            {carriedFirst.filter((oneOff) => oneOff.goalId === null).map(oneOffRow)}
            <NewOneOff daylessCount={daylessCount} />
          </Flex>
        </Section>
      </Panel>
      {doneOneOffs.length > 0 ? (
        <Panel as="div">
          <Section label={t("day.doneOneOffs.title")}>
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
      ) : null}
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
          date={dateLabel(day, t)}
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
          date={dateLabel(day, t)}
          title={t("day.title")}
          back={
            loaded.firstGoalDay !== null && shiftCivilDay(day, -1) >= loaded.firstGoalDay
              ? { href: `/dia/${shiftCivilDay(day, -1)}`, label: t("day.nav.yesterday") }
              : undefined
          }
          theme={{ toLightLabel: t("day.theme.toLight"), toDarkLabel: t("day.theme.toDark") }}
          tally={tally}
          ended={endedLines}
        />
      )}

      {evidence === "unreadable" ? (
        <EvidenceNote title={t("day.unreadableTitle")} body={t("day.unreadableBody")} />
      ) : null}

      <Split main={<>{notices}{goalsMain}</>} after={goalless} even={past} />
    </Page>
  );
}

// A one-off meant for a day before the one drawn, still undone (RP-19):
// `loadDay` carries it with its own `day`, never clamped to today's.
function isCarried(oneOff: OneOffSummary, day: string): oneOff is OneOffSummary & { day: string } {
  return oneOff.day !== null && oneOff.day < day;
}
