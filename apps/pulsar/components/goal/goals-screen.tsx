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
  Row,
  ScreenHeader,
  Section,
  Split,
  Text,
} from "@/components/ui";
import { dayBefore } from "@/lib/day/weeks";
import type {
  GoalSummary,
  MetasMonth,
  MetasOpenGoal,
} from "@/lib/queries/goal";
import { civilDateInZone, civilDayMonthShort } from "@/lib/zone";

/**
 * `MetasCentro`, `MetasCentroEscritorio` and `MetasVacio` (RP-11, RP-24, RP-27,
 * RP-37): the goals, and «el plan» inside them. The page fetches; this draws.
 * `connect` is the slot after «Exportar» where «Conectar una IA» goes.
 */
export async function GoalsScreen({
  open,
  ended,
  archived,
  connect,
}: {
  open: MetasOpenGoal[];
  ended: GoalSummary[];
  archived: GoalSummary[];
  connect?: ReactNode;
}) {
  const t = await getTranslations();

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
        <Section label={t("export.entry.section")}>
          <Button asChild variant="outline" block stack>
            <Link href="/metas/importar">
              {t("import.entry.title")}
              <Text variant="sentence">{t("import.entry.hint")}</Text>
            </Link>
          </Button>
          {connect}
        </Section>
      </Page>
    );
  }

  const lastDay = (goal: GoalSummary) => {
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
    const unit = goal.measureUnit ?? undefined;
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

  return (
    <Page width="full">
      <ScreenHeader title={t("common.nav.goals")} />
      <Split
        twoFifths
        main={
          <>
            <Panel as="div">
              {open.length > 0 ? (
                <Section label={t("goal.list.openTitle")}>
                  <Flex
                    direction="column"
                    role="group"
                    aria-label={t("goal.list.openTitle")}
                  >
                    {open.map((goal) => (
                      <Row
                        key={goal.id}
                        href={`/metas/${goal.id}`}
                        name={goal.name}
                        meta={t("goal.list.untilShort", { date: lastDay(goal) })}
                        metaVariant="sentence"
                        narrowMetaAbove={monthMeta(goal)}
                        wideMeta={monthMeta(goal)}
                        wideTrailing={
                          goal.month ? (
                            <Text variant="meta">
                              {t("goal.list.untilShort", { date: lastDay(goal) })}
                            </Text>
                          ) : undefined
                        }
                        trailing={chevron}
                      />
                    ))}
                  </Flex>
                  <Button asChild variant="outline" block>
                    <Link href="/metas/nueva">{t("goal.list.addAnother")}</Link>
                  </Button>
                </Section>
              ) : (
                <Button asChild block>
                  <Link href="/metas/nueva">{t("goal.none.action")}</Link>
                </Button>
              )}
            </Panel>

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
                        date: lastDay(goal),
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
              <Button asChild variant="outline" block stack>
                <Link href="/metas/importar">
                  {t("import.entry.title")}
                  <Text variant="sentence">{t("import.entry.hint")}</Text>
                </Link>
              </Button>
              {open.length + ended.length > 0 ? (
                <Button asChild variant="outline" block stack>
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
    </Page>
  );
}
