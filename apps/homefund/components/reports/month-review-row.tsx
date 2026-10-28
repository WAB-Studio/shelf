"use client";

import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useAction } from "next-safe-action/hooks";

import { markReviewedAction, unmarkReviewedAction } from "@/app/actions/month-review";
import { Button, Flex, Link, Money, Text } from "@/components/ui";
import type { ReviewItem } from "@/db/queries/month-review";
import { Link as LocaleLink } from "@/i18n/navigation";
import type { CurrencyCode } from "@/lib/currency";
import { civilDateToDate } from "@/lib/dates";
import type { Locale } from "@/lib/locales";
import { formatMoney } from "@/lib/money";
import { useActionErrorToast } from "@/lib/use-action-toast";

/**
 * One item of «Revisar el mes» (RF-155): what stood out and why, named by its description. A person
 * who may write it marks it «Está bien», takes the mark back with «Deshacer» (RF-163), or opens it
 * with «Corregir», whose back arrow returns here (a gap: into the accounts, where «Saldo real»
 * lives). A reader sees the item and who fixes it. A twin is one item for both movements.
 */
export function MonthReviewRow({ item }: { item: ReviewItem }) {
  const t = useTranslations("review");
  const format = useFormatter();
  const locale = useLocale() as Locale;
  const onError = useActionErrorToast();
  const mark = useAction(markReviewedAction, { onError });
  const unmark = useAction(unmarkReviewedAction, { onError });
  const currency = item.currency as CurrencyCode;
  const date = format.dateTime(civilDateToDate(item.occurredAt), { day: "numeric", month: "short" });
  const input = { transactionIds: item.transactionIds, rule: item.rule };

  return (
    <Flex direction="column" gap="2" py="3">
      <Flex justify="between" align="baseline" gap="3">
        <Text weight="medium">{t(`rules.${item.rule}`)}</Text>
        <Money minor={item.amountCents} currency={currency} signed={false} />
      </Flex>
      {item.description && <Text>{item.description}</Text>}
      <Text size="2" color="gray">
        {item.categoryName
          ? t("metaCategory", { account: item.accountName, date, category: item.categoryName })
          : t("meta", { account: item.accountName, date })}
      </Text>
      {item.rule === "above_usual" && item.usualCents !== null && (
        <Text size="2" color="gray">
          {t("usual", { amount: formatMoney(item.usualCents, currency, locale) })}
        </Text>
      )}
      {item.rule === "twin" && (
        <Text size="2" color="gray">
          {t("twinCount", { count: item.transactionIds.length })}
        </Text>
      )}
      {item.rule === "reconciliation_gap" && item.countedCents !== null && (
        <Text size="2" color="gray">
          {t("counted", { amount: formatMoney(item.countedCents, currency, locale) })}
        </Text>
      )}
      {item.canMark ? (
        <Flex gap="3" align="center" wrap="wrap">
          {item.reviewed ? (
            <Button variant="soft" color="gray" disabled={unmark.isPending} onClick={() => unmark.execute(input)}>
              {unmark.isPending ? t("saving") : t("undo")}
            </Button>
          ) : (
            <Button variant="soft" disabled={mark.isPending} onClick={() => mark.execute(input)}>
              {mark.isPending ? t("saving") : t("ok")}
            </Button>
          )}
          <Link asChild size="2" weight="medium">
            <LocaleLink
              prefetch={false}
              href={
                item.rule === "reconciliation_gap"
                  ? "/settings/accounts"
                  : `/movements/${item.transactionIds[0]}?review=${item.occurredAt.slice(0, 7)}`
              }
            >
              {t("fix")}
            </LocaleLink>
          </Link>
        </Flex>
      ) : (
        <Text size="2" color="gray">
          {t("readerOnly", { account: item.accountName })}
        </Text>
      )}
    </Flex>
  );
}
