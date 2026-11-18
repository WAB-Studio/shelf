import { useFormatter, useTranslations } from "next-intl";

import { Card, Flex, Heading, Money, TextLink } from "@/components/ui";
import type { CurrencyCode } from "@/lib/currency";
import { civilDateToDate } from "@/lib/dates";
import type { FixItem } from "@/lib/fund/home-lines";

function figure(cents: number, currency: string) {
  const Figure = () => <Money minor={cents} currency={currency as CurrencyCode} size="inherit" />;
  return Figure;
}

/**
 * «Por arreglar»: what is odd in the person's money right now, one line each and each a way into its fix (a pocket or
 * account below zero, deliveries in Bandeja, cuotas paid short, accounts not counted). Inicio and «Revisar el mes»
 * draw the same list. Nothing when nothing is odd.
 */
export function FixLines({ items }: { items: FixItem[] }) {
  const t = useTranslations("dashboard");
  const format = useFormatter();
  const shortDate = (date: string) => format.dateTime(civilDateToDate(date), { day: "numeric", month: "short" });
  if (items.length === 0) return null;

  return (
    <Card data-line="fix">
      <Flex direction="column" gap="2">
        <Heading as="h2" size="4">
          {t("fixTitle")}
        </Heading>
        {items.map((item) => {
          switch (item.kind) {
            case "pocket":
              return (
                <TextLink key={`pocket:${item.pocketName}`} href="/settings/accounts" size="2" flow>
                  {t.rich("fixPocket", { pocket: item.pocketName, amount: figure(item.shortCents, item.currency) })}
                </TextLink>
              );
            case "negative":
              return (
                <TextLink key={`negative:${item.name}`} href="/settings/accounts" size="2" flow>
                  {t.rich("fixNegative", { name: item.name, amount: figure(item.cents, item.currency) })}
                </TextLink>
              );
            case "inbox":
              return (
                <TextLink key="inbox" href="/inbox" size="2" flow>
                  {t("fixInbox", { count: item.count })}
                </TextLink>
              );
            case "short":
              return (
                <TextLink key={`short:${item.accountId}`} href={`/planning/debts/${item.accountId}`} size="2" flow>
                  {t.rich("fixShort", {
                    name: item.name,
                    count: item.count,
                    amount: figure(item.shortCents, item.currency),
                  })}
                </TextLink>
              );
            case "overdue":
              return (
                <TextLink key={`overdue:${item.accountId}`} href={`/planning/debts/${item.accountId}`} size="2" flow>
                  {t.rich("fixOverdue", {
                    name: item.name,
                    number: item.number,
                    amount: figure(item.amountCents, item.currency),
                    date: shortDate(item.dueOn),
                  })}
                </TextLink>
              );
            case "reconcile":
              return (
                <TextLink key="reconcile" href="/settings/accounts/reconcile" size="2" flow>
                  {t("reconcileNudgeLine", { count: item.count })}
                </TextLink>
              );
          }
        })}
      </Flex>
    </Card>
  );
}
