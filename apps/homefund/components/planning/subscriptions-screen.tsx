import { Info } from "lucide-react";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";

import {
  Callout,
  Card,
  DateTile,
  EmptyState,
  Eyebrow,
  Figures,
  Flex,
  FundChip,
  Grid,
  Money,
  MovementRow,
  ScreenHeader,
  Text,
} from "@/components/ui";
import type { RecurringCharge } from "@/db/queries/spending-patterns";
import type { CurrencyCode } from "@/lib/currency";
import { civilDateToDate, todayInBogota } from "@/lib/dates";
import { monthlyByCurrency } from "@/lib/fund/subscriptions";
import type { Locale } from "@/lib/locales";
import { formatMoney } from "@/lib/money";
import { tagFigure } from "@/lib/privacy";

/**
 * «Suscripciones» (RF-185): the charges HomeFund finds repeating by fixed rules, soonest next
 * charge first, with what they cost a month per currency. Read only: nothing here writes.
 */
export async function SubscriptionsScreen({
  charges,
  hasGroup,
}: {
  charges: RecurringCharge[];
  hasGroup: boolean;
}) {
  const [t, tFund, format, locale] = await Promise.all([
    getTranslations("subscriptions"),
    getTranslations("fund"),
    getFormatter(),
    getLocale() as Promise<Locale>,
  ]);
  const today = todayInBogota();

  const running = charges.filter((charge) => charge.active);
  const stopped = charges.filter((charge) => !charge.active);

  // A month's cost per currency, never summed across currencies.
  const perMonth = monthlyByCurrency(running)
    .map(([currency, cents]) => t("perMonth", { amount: tagFigure(formatMoney(cents, currency, locale)) }))
    .join(" · ");

  const card = (charge: RecurringCharge) => {
    const shown = civilDateToDate(charge.active ? charge.nextExpected : charge.lastDate);
    const longDate = format.dateTime(shown, { day: "numeric", month: "long" });
    // Within the grace a running charge may be late: its date is then the one it was due.
    const note = !charge.active
      ? t("lastCharge", { date: format.dateTime(shown, { day: "numeric", month: "long", year: "numeric" }) })
      : charge.nextExpected < today
        ? t("lateCharge", { date: longDate, count: charge.occurrences })
        : t("nextCharge", { date: longDate, count: charge.occurrences });
    return (
      <Card key={`${charge.accountId}:${charge.currency}:${charge.name}`}>
        <Flex direction="column" gap="2">
          <MovementRow
            tile={
              <DateTile
                day={format.dateTime(shown, { day: "numeric" })}
                month={format.dateTime(shown, { month: "short" })}
              />
            }
            title={charge.name}
            subtitle={[t(charge.cadence), charge.accountName, charge.category].filter(Boolean).join(" · ")}
            amount={<Money minor={charge.typicalCents} currency={charge.currency as CurrencyCode} signed={false} />}
            tone="transfer"
            wrap
          />
          <Text size="2" color="gray">
            {note}
          </Text>
        </Flex>
      </Card>
    );
  };

  const section = (label: string, rows: RecurringCharge[]) =>
    rows.length > 0 && (
      <Flex direction="column" gap="3">
        <Eyebrow size="1" weight="medium" color="gray">
          {label}
        </Eyebrow>
        <Grid columns={{ initial: "1", md: "2", xl: "3" }} gap="3">
          {rows.map(card)}
        </Grid>
      </Flex>
    );

  return (
    <Flex direction="column" gap="4">
      <ScreenHeader
        title={t("title")}
        meta={hasGroup ? <FundChip label={tFund("label")} /> : undefined}
        figure={
          running.length > 0 ? (
            <Figures>{perMonth}</Figures>
          ) : undefined
        }
      />

      {charges.length === 0 ? (
        <EmptyState title={t("emptyTitle")} description={t("emptyDescription")} />
      ) : (
        <>
          {section(t("running", { count: running.length }), running)}
          {section(t("stopped", { count: stopped.length }), stopped)}
        </>
      )}

      <Callout.Root color="gray" variant="soft">
        <Callout.Icon>
          <Info size={16} aria-hidden />
        </Callout.Icon>
        <Callout.Text>{t("hint")}</Callout.Text>
      </Callout.Root>
    </Flex>
  );
}
