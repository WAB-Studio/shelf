"use client";

import { Fragment } from "react";
import { useFormatter, useLocale, useTranslations } from "next-intl";

import { Callout, Flex, Money, Panel, PanelBlock, Separator, Text } from "@/components/ui";
import type { CardDeferralRow } from "@/db/queries/card-deferrals";
import type { CurrencyCode } from "@/lib/currency";
import { useMoneyText } from "@/lib/use-privacy";

/**
 * The deferrals the issuer prints on a card's statement (RF-253): each one's cuota, rate and pending
 * balance, what a month of it costs in interest and what paying it off today saves. One that charges
 * interest over more than one cuota carries the notice that says what it will cost. Every figure
 * arrives derived from the server; nothing is summed across currencies (RF-124). `cardNames` names the
 * card each one belongs to, for a list that spans cards.
 */
export function CardDeferrals({ rows, cardNames }: { rows: CardDeferralRow[]; cardNames?: Record<string, string> }) {
  const moneyText = useMoneyText();
  const t = useTranslations("cardDeferrals");
  const format = useFormatter();
  const locale = useLocale();
  const money = (cents: number, currency: string) => moneyText(cents, currency as CurrencyCode, locale);

  return (
    <Panel title={t("title")}>
      {rows.map((row, index) => (
        <Fragment key={row.id}>
          {index > 0 && <Separator size="4" />}
          <PanelBlock>
            <Flex direction="column" gap="1">
              <Flex align="baseline" justify="between" gap="3">
                <Text size="3" weight="medium">
                  {row.description}
                </Text>
                <Money minor={row.pendingBalanceCents} currency={row.currency as CurrencyCode} signed={false} />
              </Flex>
              <Text size="2" color="gray">
                {t("step", {
                  current: row.currentInstalment,
                  total: row.instalments,
                  amount: money(row.monthlyInstalmentCents, row.currency),
                  rate: format.number(Number(row.annualRate), {
                    style: "percent",
                    minimumFractionDigits: 1,
                    maximumFractionDigits: 2,
                  }),
                })}
              </Text>
              {cardNames?.[row.accountId] && (
                <Text size="2" color="gray">
                  {t("onCard", { card: cardNames[row.accountId] })}
                </Text>
              )}
              <Text size="2" color="gray">
                {t("authorization", { number: row.authorizationNumber })}
              </Text>
              {row.chargesInterest && (
                <>
                  <Text size="2" color="gray">
                    {t("monthlyInterest", { amount: money(row.monthlyInterestCents, row.currency) })}
                  </Text>
                  <Text size="2" color="gray">
                    {t("payOffSaves", { amount: money(row.savingsCents, row.currency) })}
                  </Text>
                  <Callout.Root color="amber" variant="soft" role="status">
                    <Callout.Text>
                      {t("notice", { count: row.instalments, amount: money(row.savingsCents, row.currency) })}
                    </Callout.Text>
                  </Callout.Root>
                </>
              )}
            </Flex>
          </PanelBlock>
        </Fragment>
      ))}
    </Panel>
  );
}
