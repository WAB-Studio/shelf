import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import type { MessageKey } from "@/i18n/translator";
import { civilSpan } from "@/lib/export/sections";
import { LIST_TAIL, tailOf } from "@/lib/lists/tail";
import { loadGoal } from "@/lib/queries/goal";
import { isTimeUnit } from "@/lib/units/time";
import { Page, ScreenHeader, Section, Table, Text, TextLink, type TableRow } from "@/components/ui";

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
  // here). No table for a measure that does not exist.
  if (!goal.measureUnit || !goal.measureName) {
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

  const columns = [
    t("goal.review.columns.week"),
    t("goal.review.columns.total"),
    t("goal.review.columns.phase"),
    t("goal.review.columns.note"),
  ];

  // The phase is named where it starts, not on every week it spans.
  // A goal with no end shows its last 12 weeks, the current one last, unless asked for all.
  const { shown, hidden } = goal.horizon === null ? tailOf(goal.weeks, all) : { shown: goal.weeks, hidden: 0 };

  const rows: TableRow[] = shown.map((week, index) => {
    const phase = week.phaseName !== shown[index - 1]?.phaseName ? (week.phaseName ?? "") : "";
    const note = week.current ? t("goal.review.current") : "";
    return {
      key: String(week.index),
      cells: [t("goal.review.weekLabel", { n: week.index }), week.total, phase, note],
      note: note || undefined,
      detail: civilSpan(week.startsOn, week.endsOn),
    };
  });

  const currentIndex = shown.findIndex((week) => week.current);
  const seeLess =
    all && goal.horizon === null && goal.weeks.length > LIST_TAIL ? (
      <TextLink href={`/metas/${goal.id}/revision`}>{t("common.seeLess")}</TextLink>
    ) : null;

  return (
    <Page width="full">
      <ScreenHeader title={t("goal.review.title")} back={back} />
      <Text as="p" variant="sentence">
        {isTimeUnit(goal.measureUnit)
          ? t("goal.review.measureTime")
          : t("goal.review.measure", { unit: unitWord(goal.measureUnit) })}
      </Text>
      {seeLess}
      <Table
        caption={t("goal.review.caption")}
        columns={columns}
        rows={rows}
        figures={[1]}
        unit={goal.measureUnit}
        current={currentIndex === -1 ? undefined : currentIndex}
        fitDetail
      />
      {hidden > 0 ? (
        <TextLink href={`/metas/${goal.id}/revision?todo=1`}>{t("common.seeAll")}</TextLink>
      ) : null}
      {seeLess}
    </Page>
  );
}
