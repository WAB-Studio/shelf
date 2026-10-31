import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import type { MessageKey } from "@/i18n/translator";
import { distinctMeasureName } from "@/lib/export/measure";
import { civilSpan } from "@/lib/export/sections";
import { LIST_TAIL, tailOf } from "@/lib/lists/tail";
import { loadGoal } from "@/lib/queries/goal";
import { isTimeUnit } from "@/lib/units/time";
import { Figure, Page, ScreenHeader, Section, Text, TextLink, WeekBars, type WeekBar } from "@/components/ui";

/**
 * `RevisionAncha.dc.html` (RP-17): the goal's own
 * measure, one row per week from its opening to the week holding today —
 * `loadGoal`'s own `weeks`, drawn through `Table`'s one set of props rather
 * than two markups. `null` reads as "not there" (`loadGoal`'s own contract,
 * `lib/queries/goal.ts`) and is the only failure this screen catches; every
 * other rejection reaches the error boundary — no `.catch` here, unlike
 * `goal-screen.tsx`'s own sibling routes.
 */
export async function ReviewScreen({ goalId, all = false }: { goalId: string; all?: boolean }) {
  const goal = await loadGoal(goalId);
  if (!goal) notFound();

  const t = await getTranslations();

  const back = { href: `/metas/${goal.id}`, place: goal.name };
  // The catalogue's word for a stored unit; a unit it lacks prints as typed.
  const unitWord = (unit: string) => {
    const key = `units.words.${unit.trim().toLowerCase()}` as MessageKey;
    return /^\p{L}+$/u.test(unit.trim()) && t.has(key) ? t(key, { count: 2 }) : unit;
  };

  // §0.3, 3: a goal whose first quantity commitment has not landed yet has
  // nothing to sum and nothing to place in a week (RP-14's own rule, carried
  // here). No table for a measure that does not exist. A holder measures
  // through its goals' summed unit and has no name of its own (RP-123).
  if (!goal.measureUnit || (!goal.measureName && !goal.holdsGoals)) {
    return (
      <Page width="full">
        <ScreenHeader title={t("goal.review.title")} back={back} />
        <Section as="div">
          <Text as="p" variant="sentence">
            {t("goal.review.noMeasure")}
          </Text>
        </Section>
      </Page>
    );
  }

  const measureName = distinctMeasureName(goal.measureName, goal.measureUnit, [unitWord(goal.measureUnit)]);

  // The phase is named where it starts, not on every week it spans.
  // A goal with no end shows its last 12 weeks, the current one last, unless asked for all.
  const { shown, hidden } = goal.horizon === null ? tailOf(goal.weeks, all) : { shown: goal.weeks, hidden: 0 };

  // The longest week sets the scale; the plan's weekly pace is the monthly rhythm over the weeks of a month.
  const longest = Math.max(1, ...shown.map((week) => week.total));
  const pace = goal.rhythm === null ? null : (goal.rhythm * 12) / 52;
  const scale = Math.max(longest, pace ?? 0);
  const bars: WeekBar[] = shown.map((week, index) => {
    const before = shown[index - 1]?.phaseName ?? null;
    const after = shown[index + 1]?.phaseName ?? null;
    const same = (name: string | null) => name !== null && name === week.phaseName;
    return {
      key: String(week.index),
      label: t("goal.review.weekLabel", { n: week.index }),
      detail: civilSpan(week.startsOn, week.endsOn),
      total: <Figure variant="meta" value={week.total} unit={goal.measureUnit ?? undefined} />,
      percent: (week.total * 100) / scale,
      plan: pace === null ? null : (pace * 100) / scale,
      current: week.current,
      phase: week.phaseName !== before ? (week.phaseName ?? undefined) : undefined,
      phaseRun:
        week.phaseName === null
          ? null
          : same(before) && same(after)
            ? "middle"
            : same(before)
              ? "end"
              : same(after)
                ? "start"
                : "only",
    };
  });

  const seeLess =
    all && goal.horizon === null && goal.weeks.length > LIST_TAIL ? (
      <TextLink href={`/metas/${goal.id}/revision`}>{t("common.seeLess")}</TextLink>
    ) : null;

  const earlier =
    hidden > 0 ? <TextLink href={`/metas/${goal.id}/revision?todo=1`}>{t("goal.review.earlier", { count: hidden })}</TextLink> : null;

  return (
    <Page width="full">
      <ScreenHeader title={t("goal.review.title")} back={back} />
      <Text as="p" variant="sentence">
        {measureName !== null
          ? isTimeUnit(goal.measureUnit)
            ? t("goal.review.measureNamedTime", { name: measureName })
            : t("goal.review.measureNamed", { name: measureName, unit: unitWord(goal.measureUnit) })
          : isTimeUnit(goal.measureUnit)
            ? t("goal.review.measureTime")
            : t("goal.review.measure", { unit: unitWord(goal.measureUnit) })}
      </Text>
      {seeLess ?? earlier}
      <WeekBars caption={t("goal.review.caption")} bars={bars} planLabel={t("goal.review.planMark")} />
      {hidden > 0 ? (
        <TextLink href={`/metas/${goal.id}/revision?todo=1`}>{t("common.seeAll")}</TextLink>
      ) : null}
      {seeLess}
    </Page>
  );
}
