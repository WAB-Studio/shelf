"use client";

import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useAction } from "next-safe-action/hooks";

import { markReviewedAction } from "@/app/actions/month-review";
import { Button, Flex, Link, Money, Text } from "@/components/ui";
import type { ReviewItem } from "@/db/queries/month-review";
import { Link as LocaleLink } from "@/i18n/navigation";
import type { CurrencyCode } from "@/lib/currency";
import { civilDateToDate } from "@/lib/dates";
import type { Locale } from "@/lib/locales";
import { formatMoney } from "@/lib/money";
import { useActionErrorToast } from "@/lib/use-action-toast";

/**
 * One item of «Revisar el mes» (RF-155): what stood out and why, with «Está bien»
 * for a person who may write it and «Corregir» into the movement (a gap: into the
 * accounts, where «Saldo real» lives). A twin is one item for both movements.
 */
export function MonthReviewRow({ item }: { item: ReviewItem }) {
  const t = useTranslations("review");
  const format = useFormatter();
  const locale = useLocale() as Locale;
  const onError = useActionErrorToast();
  const mark = useAction(markReviewedAction, { onError });
  const currency = item.currency as CurrencyCode;
  const date = format.dateTime(civilDateToDate(item.occurredAt), { day: "numeric", month: "short" });

  return (
    <Flex direction="column" gap="2" py="3">
      <Flex justify="between" align="baseline" gap="3">
        <Text weight="medium">{t(`rules.${item.rule}`)}</Text>
        <Money minor={item.amountCents} currency={currency} signed={false} />
      </Flex>
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
      <Flex gap="3" align="center" wrap="wrap">
        {item.canMark && (
          <Button
            variant="soft"
            disabled={mark.isPending}
            onClick={() => mark.execute({ transactionIds: item.transactionIds, rule: item.rule })}
          >
            {mark.isPending ? t("saving") : t("ok")}
          </Button>
        )}
        <Link asChild size="2" weight="medium">
          <LocaleLink
            href={
              item.rule === "reconciliation_gap"
                ? "/settings/accounts"
                : `/movements/${item.transactionIds[0]}`
            }
          >
            {t("fix")}
          </LocaleLink>
        </Link>
      </Flex>
    </Flex>
  );
}
