"use client";

import { useState } from "react";
import { useFormatter, useTranslations } from "next-intl";

import { Button, Flex, Heading, Link, Panel, Separator, Text } from "@/components/ui";
import type { MonthReview } from "@/db/queries/month-review";
import { Link as LocaleLink } from "@/i18n/navigation";
import { addCivilMonths, civilDateToDate } from "@/lib/dates";

import { MonthReviewRow } from "./month-review-row";

/**
 * «Revisar el mes» (RF-155): the closed month's items by the four fixed rules,
 * the ones still to look at first and the marked ones folded under «Revisados».
 * ‹ › step between closed months, from the first movement's to last month.
 */
export function MonthReviewScreen({ review, lastClosed }: { review: MonthReview; lastClosed: string }) {
  const t = useTranslations("review");
  const format = useFormatter();
  const [showReviewed, setShowReviewed] = useState(false);
  const monthName = format.dateTime(civilDateToDate(`${review.month}-01`), { month: "long", year: "numeric" });
  const prev = addCivilMonths(`${review.month}-01`, -1).slice(0, 7);
  const next = addCivilMonths(`${review.month}-01`, 1).slice(0, 7);
  const hasPrev = review.firstMonth !== null && prev >= review.firstMonth;
  const hasNext = next <= lastClosed;
  const pending = review.items.filter((item) => !item.reviewed);
  const reviewed = review.items.filter((item) => item.reviewed);
  const key = (item: MonthReview["items"][number]) => `${item.rule}:${item.transactionIds.join(",")}`;

  return (
    <Flex direction="column" gap="5">
      <Flex direction="column" gap="2">
        <Heading size="6">{t("title", { month: monthName })}</Heading>
        {(hasPrev || hasNext) && (
          <Flex justify={hasPrev ? "between" : "end"} gap="3">
            {hasPrev && (
              <Link asChild size="2" weight="medium">
                <LocaleLink href={`/reports/review?month=${prev}`}>{t("prev")}</LocaleLink>
              </Link>
            )}
            {hasNext && (
              <Link asChild size="2" weight="medium">
                <LocaleLink href={`/reports/review?month=${next}`}>{t("next")}</LocaleLink>
              </Link>
            )}
          </Flex>
        )}
      </Flex>

      {review.items.length === 0 ? (
        <Text as="p">{t("empty", { month: monthName })}</Text>
      ) : pending.length === 0 ? (
        <Text as="p">{t("allDone", { month: monthName })}</Text>
      ) : (
        <Panel>
          {pending.map((item, index) => (
            <Flex key={key(item)} direction="column">
              {index > 0 && <Separator size="4" />}
              <MonthReviewRow item={item} />
            </Flex>
          ))}
        </Panel>
      )}

      {reviewed.length > 0 && (
        <Flex direction="column" gap="2">
          <Button variant="ghost" aria-expanded={showReviewed} onClick={() => setShowReviewed((open) => !open)}>
            {t("reviewed", { count: reviewed.length })}
          </Button>
          {showReviewed && (
            <Panel>
              {reviewed.map((item, index) => (
                <Flex key={key(item)} direction="column">
                  {index > 0 && <Separator size="4" />}
                  <MonthReviewRow item={{ ...item, canMark: false }} />
                </Flex>
              ))}
            </Panel>
          )}
        </Flex>
      )}
    </Flex>
  );
}
