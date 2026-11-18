"use client";

import { Fragment, useState } from "react";
import { useFormatter, useTranslations } from "next-intl";

import { Button, Flex, Link, Panel, PanelBlock, ScreenHeader, Separator, Text } from "@/components/ui";
import type { MonthReview } from "@/db/queries/month-review";
import type { FixItem } from "@/lib/fund/home-lines";
import { Link as LocaleLink } from "@/i18n/navigation";
import { civilDateToDate, shiftMonth } from "@/lib/dates";

import { FixLines } from "./fix-lines";
import { MonthReviewRow } from "./month-review-row";

type ReviewItem = MonthReview["items"][number];

function ReviewList({ items, creatorNames }: { items: ReviewItem[]; creatorNames: Record<string, string> }) {
  return (
    <Panel>
      {items.map((item, index) => (
        <Fragment key={`${item.rule}:${item.transactionIds.join(",")}`}>
          {index > 0 && <Separator size="4" />}
          <PanelBlock>
            <MonthReviewRow item={item} creatorNames={creatorNames} />
          </PanelBlock>
        </Fragment>
      ))}
    </Panel>
  );
}

/**
 * «Revisar el mes» (RF-155): the month's items by the four fixed rules,
 * the ones still to look at first and the marked ones folded under «Revisados»,
 * under «Por arreglar» when the month is the current one. ‹ › step between months,
 * from the first movement's to the current one. «Nada sobresale» only when both lists are empty.
 */
export function MonthReviewScreen({
  review,
  lastMonth,
  fixes,
  creatorNames,
}: {
  review: MonthReview;
  // The newest month, the current one: nothing is reviewed ahead of it.
  lastMonth: string;
  // What is odd right now; empty for a month that is over.
  fixes: FixItem[];
  creatorNames: Record<string, string>;
}) {
  const t = useTranslations("review");
  const format = useFormatter();
  const [showReviewed, setShowReviewed] = useState(false);
  const monthName = format.dateTime(civilDateToDate(`${review.month}-01`), { month: "long", year: "numeric" });
  const prev = shiftMonth(review.month, -1);
  const next = shiftMonth(review.month, 1);
  const hasPrev = review.firstMonth !== null && prev >= review.firstMonth;
  const hasNext = next <= lastMonth;
  const pending: ReviewItem[] = [];
  const reviewed: ReviewItem[] = [];
  for (const item of review.items) (item.reviewed ? reviewed : pending).push(item);

  return (
    <Flex direction="column" gap="5">
      <Flex direction="column" gap="2">
        <ScreenHeader title={t("title", { month: monthName })} back={{ href: "/reports", label: t("back") }} />
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

      <FixLines items={fixes} />

      {review.items.length === 0 ? (
        fixes.length === 0 && <Text as="p">{t(review.noted ? "empty" : "nothingNoted", { month: monthName })}</Text>
      ) : pending.length === 0 ? (
        fixes.length === 0 && <Text as="p">{t("allDone", { month: monthName })}</Text>
      ) : (
        <ReviewList items={pending} creatorNames={creatorNames} />
      )}

      {reviewed.length > 0 && (
        <Flex direction="column" gap="2">
          <Button variant="ghost" aria-expanded={showReviewed} onClick={() => setShowReviewed((open) => !open)}>
            {t("reviewed", { count: reviewed.length })}
          </Button>
          {showReviewed && <ReviewList items={reviewed} creatorNames={creatorNames} />}
        </Flex>
      )}
    </Flex>
  );
}
