import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";

import {
  Button,
  Figure,
  Flex,
  Page,
  Panel,
  PanelGrid,
  Progress,
  Row,
  ScreenHeader,
  Section,
  Split,
  Text,
  TextLink,
} from "@/components/ui";
import { SignOutButton } from "@/components/account/sign-out-button";
import { GoalBranch, type BranchGoal } from "@/components/goal/goal-branch";
import { RetiredHabits } from "@/components/goal/retired-habits";
import { dayBefore } from "@/lib/day/weeks";
import { cadencePhrase } from "@/lib/day/row-phrases";
import type {
  GoalSummary,
  LooseCommitment,
  MetasMonth,
  MetasOpenGoal,
} from "@/lib/queries/goal";
import { civilDateInZone, civilDayMonthShort, civilDayMonthYear } from "@/lib/zone";

/**
 * `MetasCentro`, `MetasCentroEscritorio` and `MetasVacio` (RP-11, RP-24, RP-27,
 * RP-37): the goals, and «el plan» inside them. The page fetches; this draws.
 * `connect` is the slot after «Exportar» where «Conectar una IA» goes.
 */
export async function GoalsScreen({
  open,
  ended,
  archived,
  habits,
  connect,
  email,
}: {
  open: MetasOpenGoal[];
  ended: GoalSummary[];
  archived: GoalSummary[];
  // The commitments that belong to no goal, retired ones included (RP-100).
  habits: LooseCommitment[];
  connect?: ReactNode;
  // Who is signed in, for «Tu cuenta» (RP-141).
  email?: string;
}) {
  const t = await getTranslations();

  // `HabitosSueltos`: each live habit with its cadence and its note; tapping one opens its screen.
  const cadenceNames = {
    weekdayName: t.raw("day.cadence.weekdayName") as string[],
    weekdayPlural: t.raw("day.cadence.weekdayPlural") as string[],
  };
  const liveHabits = habits.filter((habit) => habit.retiredAt === null);
  // The latest retired first; the loader's order is the live order.
  const retiredHabits = habits
    .filter((habit) => habit.retiredAt !== null)
    .sort((a, b) => Date.parse(b.retiredAt!) - Date.parse(a.retiredAt!))
    .map((habit) => ({
      id: habit.id,
      name: habit.name,
      retiredLine: t("habit.retiredOn", { date: civilDayMonthYear(civilDateInZone(new Date(habit.retiredAt!))) }),
    }));
  const habitsSection = (
    <Panel as="div">
      <Section label={t("goal.habits.title")}>
        {liveHabits.length === 0 ? (
          <Text as="p" variant="sentence" tone="muted">
            {t("goal.habits.none")}
          </Text>
        ) : (
          <Flex direction="column">
            {liveHabits.map((habit) => (
              <Row
                key={habit.id}
                href={`/metas/habitos/${habit.id}`}
                name={habit.name}
                meta={
                  <>
                    {cadencePhrase((key, values) => t(key, values), habit.cadence, cadenceNames) ?? t("day.cadence.everyDay")}
                    {habit.satisfiedBy.kind === "quantity" ? (
                      <>
                        {" · "}
                        <Figure value={habit.satisfiedBy.target} unit={habit.satisfiedBy.unit} variant="meta" />
                      </>
                    ) : null}
                  </>
                }
                metaVariant="sentence"
                preview={habit.note}
                trailing={<ChevronRight size={16} strokeWidth={1.5} aria-hidden />}
              />
            ))}
          </Flex>
        )}
        {retiredHabits.length > 0 ? (
          <Flex direction="column">
            <RetiredHabits
              habits={retiredHabits}
              label={t("goal.habits.retired")}
              foldLabel={t("goal.habits.foldRetired")}
              unfoldLabel={t("goal.habits.unfoldRetired")}
            />
          </Flex>
        ) : null}
        <Button asChild variant="outline" block>
          <Link href="/metas/habitos/nuevo">{t("goal.habits.add")}</Link>
        </Button>
      </Section>
    </Panel>
  );

  // `MetasCerrarSesion`: the foot of the page, after «El plan».
  const accountSection =
    email === undefined ? null : (
      <Panel>
        <Section label={t("account.accountTitle")}>
          <Text as="p" variant="sentence" tone="muted">
            {t("account.signedInAs", { email })}
          </Text>
          <SignOutButton />
        </Section>
      </Panel>
    );

  if (open.length === 0 && ended.length === 0 && archived.length === 0) {
    return (
      <Page>
        <ScreenHeader title={t("goal.none.title")} />
        <Text as="p" variant="sentence" tone="secondary">
          {t("goal.none.body")}
        </Text>
        <Button asChild block>
          <Link href="/metas/nueva">{t("goal.none.action")}</Link>
        </Button>
        {habitsSection}
        <Section label={t("export.entry.section")}>
          <Button asChild variant="quiet" block stack>
            <Link href="/metas/importar">
              {t("import.entry.title")}
              <Text variant="sentence">{t("import.entry.hint")}</Text>
            </Link>
          </Button>
          {connect}
        </Section>
        {accountSection}
      </Page>
    );
  }

  // Null: a goal with no end, which is never among the ended.
  const lastDay = (goal: GoalSummary) => {
    if (goal.horizon === null) return null;
    const day = dayBefore(goal.horizon);
    return `${civilDayMonthShort(day)} ${day.slice(0, 4)}`;
  };
  const archivedLine = (goal: GoalSummary) => {
    if (!goal.archivedAt) return undefined;
    const day = civilDateInZone(new Date(goal.archivedAt));
    return t("goal.list.archivedOnShort", { date: `${civilDayMonthShort(day)} ${day.slice(0, 4)}` });
  };
  const monthName = (month: string) =>
    (t.raw("day.monthLong") as string[])[Number(month.slice(5, 7)) - 1];
  const monthMeta = (goal: MetasOpenGoal) => {
    const month: MetasMonth | null = goal.month;
    if (!month) return undefined;
    if (month.kind === "tasks") {
      return t("goal.list.monthTasks", {
        month: monthName(month.month),
        done: month.done,
        total: month.total,
      });
    }
    const unit = goal.monthUnit ?? undefined;
    return (
      <>
        {monthName(month.month)} ·{" "}
        <Figure
          value={month.reached}
          unit={unit}
          variant="meta"
          bare={month.planned !== null}
        />
        {month.planned === null ? null : (
          <>
            {" "}
            {t("day.monthLine.of")}{" "}
            <Figure value={month.planned} unit={unit} variant="meta" />
          </>
        )}
      </>
    );
  };
  const chevron = <ChevronRight size={16} strokeWidth={1.5} aria-hidden />;

  // The tree as `/metas` draws it: depth and holding are read among the open
  // goals, so with no goal inside another every row is flush and arrowless.
  const parentOf = new Map(open.map((goal) => [goal.id, goal.parentId]));
  const inside = new Map<string, number>();
  for (const goal of open) {
    if (goal.parentId && parentOf.has(goal.parentId)) {
      inside.set(goal.parentId, (inside.get(goal.parentId) ?? 0) + 1);
    }
  }
  const depthOf = (goal: MetasOpenGoal): 0 | 1 | 2 => {
    let depth = 0;
    for (let up = goal.parentId; up && parentOf.has(up); up = parentOf.get(up) ?? null) depth += 1;
    return Math.min(depth, 2) as 0 | 1 | 2;
  };
  const branch: BranchGoal[] = open.map((goal) => {
    const count = inside.get(goal.id) ?? 0;
    const depth = depthOf(goal);
    const last = lastDay(goal);
    const until =
      last === null
        ? count > 0
          ? t("tree.list.noEndInside", { count })
          : t("goal.list.noEnd")
        : count > 0
          ? t("tree.list.untilInside", { date: last, count })
          : t("goal.list.untilShort", { date: last });
    return {
      id: goal.id,
      parentId: depth > 0 ? goal.parentId : null,
      depth,
      slot: depth > 0 || count > 0,
      holds: count > 0,
      foldLabel: t("tree.list.foldNamed", { name: goal.name }),
      unfoldLabel: t("tree.list.unfoldNamed", { name: goal.name }),
      name: goal.name,
      meta: until,
      narrowMetaAbove: monthMeta(goal),
      wideMeta: monthMeta(goal),
      wideTrailing: goal.month ? <Text variant="meta">{until}</Text> : undefined,
    };
  });

  // A card a goal: the month's figure big, its bar, the phase in effect and the weeks left. A tree of goals
  // keeps its list, where depth and folding live.
  const cards =
    open.length > 0 && inside.size === 0 ? (
      <PanelGrid>
        {open.map((goal) => {
          const month: MetasMonth | null = goal.month;
          const unit = goal.monthUnit ?? undefined;
          const percent =
            month?.kind === "amount" && month.planned ? Math.min(100, Math.floor((month.reached * 100) / month.planned)) : null;
          return (
            <Panel as="div" key={goal.id}>
              <Section label={goal.name}>
                {month?.kind === "amount" ? (
                  <Flex align="baseline" gap="2" wrap="wrap">
                    <Figure variant="big" value={month.reached} unit={unit} bare={month.planned !== null} />
                    {month.planned !== null ? (
                      <Text variant="sentence">
                        {t("day.monthLine.of")} <Figure value={month.planned} unit={unit} variant="meta" />
                      </Text>
                    ) : null}
                  </Flex>
                ) : month?.kind === "tasks" ? (
                  <Text as="p" variant="sentence">
                    {t("goal.list.monthTasks", { month: monthName(month.month), done: month.done, total: month.total })}
                  </Text>
                ) : null}
                {percent !== null ? <Progress percent={percent} size="thick" /> : null}
                {goal.phaseAim ? (
                  <Text as="p" variant="sentence">
                    {t("goal.list.phaseNow", { aim: goal.phaseAim })}
                  </Text>
                ) : null}
                <Text as="p" variant="sentence" tone="muted">
                  {goal.weeksLeft === null ? t("goal.list.noEnd") : t("goal.list.weeksLeft", { count: goal.weeksLeft })}
                </Text>
                <TextLink href={`/metas/${goal.id}`}>{t("goal.list.openGoal", { name: goal.name })}</TextLink>
              </Section>
            </Panel>
          );
        })}
      </PanelGrid>
    ) : null;

  return (
    <Page width="full">
      <ScreenHeader chat title={t("common.nav.goals")} />
      <Split
        twoFifths
        main={
          <>
            {cards}
            <Panel as="div">
              {open.length > 0 && !cards ? (
                <Section label={t("goal.list.openTitle")}>
                  <Flex
                    direction="column"
                    role="group"
                    aria-label={t("goal.list.openTitle")}
                  >
                    <GoalBranch goals={branch} />
                  </Flex>
                  <Button asChild variant="outline" block>
                    <Link href="/metas/nueva">{t("goal.list.addAnother")}</Link>
                  </Button>
                </Section>
              ) : cards ? (
                <Button asChild variant="outline" block>
                  <Link href="/metas/nueva">{t("goal.list.addAnother")}</Link>
                </Button>
              ) : (
                <Button asChild block>
                  <Link href="/metas/nueva">{t("goal.none.action")}</Link>
                </Button>
              )}
            </Panel>

            {habitsSection}

            {ended.length > 0 ? (
              <Panel>
                <Section label={t("goal.list.endedTitle")}>
                <Flex direction="column">
                  {ended.map((goal) => (
                    <Row
                      key={goal.id}
                      href={`/metas/${goal.id}`}
                      name={goal.name}
                      meta={t("goal.list.endedOnShort", {
                        date: lastDay(goal) ?? "",
                      })}
                      metaVariant="sentence"
                      trailing={chevron}
                    />
                  ))}
                </Flex>
                </Section>
              </Panel>
            ) : null}
          </>
        }
        tail={
          archived.length > 0 ? (
            <Panel>
              <Section label={t("goal.list.archivedTitle")}>
              <Flex direction="column">
                {archived.map((goal) => (
                  <Row
                    key={goal.id}
                    href={`/metas/${goal.id}`}
                    name={goal.name}
                    meta={archivedLine(goal)}
                    metaVariant="sentence"
                    trailing={chevron}
                  />
                ))}
              </Flex>
              </Section>
            </Panel>
          ) : null
        }
        after={
          <Panel>
            <Section label={t("export.entry.section")}>
              <Button asChild variant="quiet" block stack>
                <Link href="/metas/importar">
                  {t("import.entry.title")}
                  <Text variant="sentence">{t("import.entry.hint")}</Text>
                </Link>
              </Button>
              {open.length + ended.length > 0 ? (
                <Button asChild variant="quiet" block stack>
                  <Link href="/exportar">
                    {t("export.entry.title")}
                    <Text variant="sentence">{t("export.entry.hint")}</Text>
                  </Link>
                </Button>
              ) : null}
              {connect}
            </Section>
          </Panel>
        }
      />
      {accountSection}
    </Page>
  );
}
