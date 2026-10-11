"use client";

import { useState, useTransition, type ReactNode } from "react";
import { useTranslations } from "next-intl";

import { dismissPlanNotices } from "@/app/actions/roadmap";
import { Button, Figure, Flex, Panel, Separator, Text, TextLink } from "@/components/ui";
import { useTimeWords } from "@/components/ui/figure";
import type { MessageKey } from "@/i18n/translator";
import { movedSpan } from "@/lib/plan/moved-span";
import type { PlanNotice as Notice } from "@/lib/plan/roadmap-read";
import { formatQuantity } from "@/lib/units/time";

/**
 * `RoadmapHoyMovido.dc.html`, `RoadmapHoyMovidoDias.dc.html` (RP-52): the card
 * a goal draws on Hoy when its last month closed short. Under a week it says
 * the days and drops the sentence about the rest running behind. «Entendido»
 * writes `plan_seen`; the refresh `dismissPlanNotices` revalidates removes it.
 */
function PlanNotice({
  goalId,
  goalName,
  unit,
  notice,
  closedMonthName,
  nextMonthName,
  endDay,
  endMonthName,
  endYear,
}: {
  goalId: string;
  goalName: string;
  unit: string;
  notice: Notice;
  closedMonthName: string;
  nextMonthName: string;
  endDay: number;
  endMonthName: string;
  endYear: number;
}) {
  const t = useTranslations();
  const words = useTimeWords();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<MessageKey | null>(null);

  const { short, weeks } = movedSpan(notice.movedDays);
  const month = closedMonthName.charAt(0).toUpperCase() + closedMonthName.slice(1);
  const values = {
    month,
    done: formatQuantity(notice.closedDone, unit, words),
    amount: formatQuantity(notice.closedAmount, unit, words),
    next: nextMonthName,
    date: t("roadmap.hoyMovido.endDate", { day: endDay, month: endMonthName, year: endYear }),
  };

  function handleDismiss() {
    if (pending) return;
    setError(null);

    startTransition(() => {
      void dismissPlanNotices({ notices: [{ goalId, month: notice.closedMonth.slice(0, 7) }] }).then((result) => {
        if (!result.ok) setError(result.error);
      });
    });
  }

  return (
    <Panel as="div" bordered>
      <Flex direction="column" gap="3">
        <Text as="p" variant="title">
          {short
            ? t("roadmap.hoyMovido.titleDays", { goal: goalName, days: notice.movedDays })
            : t("roadmap.hoyMovido.title", { goal: goalName, weeks })}
        </Text>
        <Text as="p" variant="sentence">
          {t(short ? "roadmap.hoyMovido.bodyShort" : "roadmap.hoyMovido.body", values)}
        </Text>
        <Flex align="center" gap="4" wrap="wrap">
          <TextLink href={`/metas/${goalId}/plan`}>{t("roadmap.hoyMovido.seePlan")}</TextLink>
          <Button variant="ghost" onClick={handleDismiss} disabled={pending}>
            {t("roadmap.hoyMovido.dismiss")}
          </Button>
        </Flex>
        {error ? (
          <Text as="p" variant="sentence">
            {t(error)}
          </Text>
        ) : null}
      </Flex>
    </Panel>
  );
}

export type PlanNoticeItem = {
  goalId: string;
  goalName: string;
  unit: string;
  notice: Notice;
  closedMonthName: string;
  nextMonthName: string;
  endDay: number;
  endMonthName: string;
  endYear: number;
};

/**
 * `RoadmapHoyMovidoVarios.dc.html` (RP-52): two or more moved plans draw one
 * card, a line per goal and one «Entendido» that dismisses every one of them.
 * One notice keeps its own card.
 */
export function PlanNotices({ notices }: { notices: PlanNoticeItem[] }) {
  const t = useTranslations();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<MessageKey | null>(null);

  if (notices.length === 0) return null;
  if (notices.length === 1) return <PlanNotice key={notices[0].goalId} {...notices[0]} />;

  const first = notices[0];
  const month = first.closedMonthName.charAt(0).toUpperCase() + first.closedMonthName.slice(1);
  const fig = { fig: (chunks: ReactNode) => <Figure variant="meta" value={chunks} /> };

  function handleDismiss() {
    if (pending) return;
    setError(null);

    startTransition(() => {
      void dismissPlanNotices({
        notices: notices.map(({ goalId, notice }) => ({ goalId, month: notice.closedMonth.slice(0, 7) })),
      }).then((result) => {
        if (!result.ok) setError(result.error);
      });
    });
  }

  return (
    <Panel as="div" bordered>
      <Flex direction="column" gap="3">
        <Text as="p" variant="title">
          {t("roadmap.hoyMovido.several", { count: notices.length })}
        </Text>
        <Text as="p" variant="sentence">
          {t("roadmap.hoyMovido.severalBody", { month, next: first.nextMonthName })}
        </Text>
        {notices.map((item) => {
          const { short, weeks } = movedSpan(item.notice.movedDays);
          const date = t("roadmap.hoyMovido.endDate", { day: item.endDay, month: item.endMonthName, year: item.endYear });
          return (
            <Flex key={item.goalId} direction="column" gap="3">
              <Separator />
              <Flex align="center" justify="between" gap="4">
                <Flex direction="column" gap="1">
                  <Text as="p" variant="name">
                    {item.goalName}
                  </Text>
                  <Text as="p" variant="sentence">
                    {short
                      ? t.rich("roadmap.hoyMovido.severalDays", { days: item.notice.movedDays, date, ...fig })
                      : t.rich("roadmap.hoyMovido.severalWeeks", { weeks, date, ...fig })}
                  </Text>
                </Flex>
                <TextLink nowrap href={`/metas/${item.goalId}/plan`}>{t("roadmap.hoyMovido.seePlan")}</TextLink>
              </Flex>
            </Flex>
          );
        })}
        <Flex align="center">
          <Button variant="ghost" onClick={handleDismiss} disabled={pending}>
            {t("roadmap.hoyMovido.dismiss")}
          </Button>
        </Flex>
        {error ? (
          <Text as="p" variant="sentence">
            {t(error)}
          </Text>
        ) : null}
      </Flex>
    </Panel>
  );
}
