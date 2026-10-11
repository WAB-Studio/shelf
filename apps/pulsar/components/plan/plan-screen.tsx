import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { AddTask, PlanEnd } from "@/components/plan/plan-end";
import { PlanMonths } from "@/components/plan/plan-months";
import { RhythmForm } from "@/components/plan/rhythm-form";
import { RhythmSheet } from "@/components/plan/rhythm-sheet";
import {
  Flex,
  Figure,
  Page,
  Row,
  ScreenHeader,
  Section,
  Separator,
  Text,
  TextLink,
} from "@/components/ui";
import { daysBetween } from "@/lib/day/weeks";
import { releasedPlan } from "@/lib/plan/first-rhythm";
import { openMonthsOf, rhythmToMeet } from "@/lib/plan/roadmap-read";
import { loadGoal } from "@/lib/queries/goal";
import { formatQuantity, isTimeUnit, type TimeWords } from "@/lib/units/time";
import { civilDateLabel, civilDateToDate, dateToCivilDate } from "@/lib/zone";

// «20 de marzo de 2027»: the lead names the year the plan ends in.
const dateFormat = new Intl.DateTimeFormat("es-CO", {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

function dateLabel(day: string): string {
  return dateFormat.format(new Date(`${day}T12:00:00Z`));
}

function dayAfter(day: string): string {
  const date = civilDateToDate(day);
  date.setUTCDate(date.getUTCDate() + 1);
  return dateToCivilDate(date);
}

// Rows of the unplaced tasks drawn before «Y n más».
const SHOWN = 3;

/**
 * `RoadmapPlan` / `RoadmapSinRitmo` / `RoadmapSinMedida` / `RoadmapPasaElFinal`
 * (RP-50, RP-53): the goal's plan, from `loadGoal`'s `roadmap`. `all` draws every
 * month whole (`?todo=1`).
 */
export async function PlanScreen({ goalId, all = false }: { goalId: string; all?: boolean }) {
  const goal = await loadGoal(goalId);
  if (!goal) notFound();
  // A goal measured in something other than time has no plan (RP-62).
  if (goal.measureUnit !== null && !isTimeUnit(goal.measureUnit)) redirect(`/metas/${goal.id}`);

  const t = await getTranslations();
  const units = await getTranslations("units");
  const words: TimeWords = {
    h: (h) => units("h", { h }),
    min: (min) => units("min", { min }),
    join: (h, min) => units("join", { h, min }),
  };
  const unit = goal.measureUnit;
  const open = goal.archivedAt === null && goal.endedOn === null;
  const { roadmap, plan } = goal;
  const rhythmFormDrawn = open && roadmap.state === "noRhythm";
  const say = (n: number) => (unit ? formatQuantity(n, unit, words) : String(n));

  let lead: string | null = null;
  let late = false;
  if (unit && roadmap.state === "planned" && roadmap.end !== null) {
    const days = daysBetween(roadmap.end, roadmap.lastDay);
    if (days > 0) lead = t("roadmap.plan.finish", { date: dateLabel(roadmap.end), days });
    else if (days === 0) lead = t("roadmap.plan.finishOnEnd", { date: dateLabel(roadmap.end) });
    else {
      late = true;
      lead = t("roadmap.pasaElFinal.finish", {
        date: dateLabel(roadmap.end),
        weeks: Math.ceil(-days / 7),
        end: civilDateLabel(roadmap.lastDay),
      });
    }
  }
  if (unit && roadmap.state === "noRhythm") lead = t("roadmap.sinRitmo.intro");
  if (!unit) lead = t("roadmap.plan.noMeasure");

  // Undone top-level tasks fixed to a month: what a first rhythm sends back.
  const releases = releasedPlan(plan).released;
  const totalHours = roadmap.unplaced.reduce((sum, item) => sum + item.hours, 0);

  return (
    <Page width="column">
      <ScreenHeader title={t("roadmap.plan.title")} back={{ href: `/metas/${goal.id}`, place: goal.name }} />
      {lead ? (
        <Text as="p" variant="sentence">
          {lead}
        </Text>
      ) : null}
      {unit && rhythmFormDrawn ? (
        <>
          <Section>
            <RhythmForm goalId={goal.id} unit={unit} plan={plan} initial={null} releases={releases} />
          </Section>
          {roadmap.unplaced.length > 0 ? (
            <Section
              label={
                <Flex justify="between" gap="3">
                  <span>{t("roadmap.sinRitmo.noMonthYet")}</span>
                  <span>
                    {t("roadmap.sinRitmo.line", { count: roadmap.unplaced.length, hours: say(totalHours) })}
                  </span>
                </Flex>
              }
            >
              <div>
                {roadmap.unplaced.slice(0, SHOWN).map((item) => (
                  <div key={item.task.id}>
                    <Flex justify="between" gap="3" align="center" py="3">
                      <Text variant="name">{item.task.name}</Text>
                      {item.task.estimate === null && item.children.length === 0 ? (
                        <Text variant="meta" tone="muted">
                          {t("roadmap.plan.unestimated")}
                        </Text>
                      ) : (
                        <Figure variant="meta" value={item.hours} unit={unit} />
                      )}
                    </Flex>
                    <Separator />
                  </div>
                ))}
              </div>
              {roadmap.unplaced.length > SHOWN ? (
                <Text as="p" variant="sentence" tone="muted">
                  {t("roadmap.sinRitmo.more", { count: roadmap.unplaced.length - SHOWN })}
                </Text>
              ) : null}
            </Section>
          ) : null}
        </>
      ) : null}
      {unit && goal.rhythm !== null ? (
        open ? (
          <RhythmSheet
            goalId={goal.id}
            goalName={goal.name}
            unit={unit}
            plan={plan}
            initial={goal.rhythm}
            name={t("roadmap.plan.rhythm", { hours: say(goal.rhythm) })}
            trailing={
              <Text as="span" variant="name" tone="accent">
                {t("roadmap.plan.change")}
              </Text>
            }
          />
        ) : (
          <Row card rule={false} name={t("roadmap.plan.rhythm", { hours: say(goal.rhythm) })} disabled />
        )
      ) : null}
      {late && open && unit && roadmap.end !== null ? (
        <PlanEnd
          goalId={goal.id}
          goalName={goal.name}
          unit={unit}
          plan={plan}
          meets={rhythmToMeet(plan, isTimeUnit(unit) ? 60 : 1)}
          planEnd={roadmap.end}
          moveTo={dayAfter(roadmap.end)}
        />
      ) : null}
      {!unit || roadmap.state === "planned" ? <PlanMonths goal={goal} all={all} /> : null}
      {open ? (
        <AddTask
          goalId={goal.id}
          goalName={goal.name}
          unit={unit}
          months={openMonthsOf(plan)}
          variant={unit && rhythmFormDrawn ? "outline" : "solid"}
        />
      ) : null}
      <Section as="div">
        <Separator />
        <Text as="p" variant="sentence" tone="muted">
          <TextLink href={`/metas/${goal.id}/meses`}>{t("roadmap.plan.seeMonths")}</TextLink>
        </Text>
      </Section>
    </Page>
  );
}
