"use client";

import { useTranslations } from "next-intl";

import {
  BandCard,
  BandCards,
  BandFigure,
  BandStats,
  Badge,
  Button,
  Disc,
  Flex,
  Money,
  PlainLink,
  ProportionBar,
  SummaryBand,
  TapTarget,
  Text,
} from "@/components/ui";
import type { MoneyTone } from "@/components/ui";
import type { DashboardData } from "@/db/queries/reports/dashboard";
import type { OwnerNetWorthNamed } from "@/db/queries/reports/dashboard";
import { Link as LocaleLink } from "@/i18n/navigation";
import type { CurrencyCode } from "@/lib/currency";

/**
 * The home dashboard's headline: the fund's total net worth over a pill per owner
 * (RF-88), the group counting as one bucket rather than split across its members
 * (RF-67), then this month's income, expense and net. Every figure arrives already
 * derived and stays an integer in the stored scale; the reading is `Money`'s. No
 * per-account balance list lives here.
 *
 * Nothing on this screen adds two currencies (RF-124): a fund holding both draws
 * two net-worth figures, two chips for the owner who holds both, and two sets of
 * month figures — each saying which currency it counts.
 *
 * From `md` up the net worth is a band of its own and the month's figures sit in
 * one compact card under it, as display figures; below it the two blocks stack as
 * they always have. The cash withdrawal is a button beside quick entry, not a card.
 */
export function DashboardSummary({ data }: { data: DashboardData }) {
  const t = useTranslations("dashboard");
  const tc = useTranslations("common");
  const tr = useTranslations("reports");
  const tn = useTranslations("nav");

  const {
    netWorth,
    totalNetWorth,
    monthFlow,
    unreviewedCount,
    pendingDeliveryCount,
  } = data;

  // The group reads before the members it holds; `sort` is stable, so the rest
  // keep the order the query gave them.
  const buckets = [...netWorth].sort(
    (a, b) => Number(b.bucket === "group") - Number(a.bucket === "group"),
  );

  return (
    <SummaryBand>
      <BandCards>
        <BandCard ratio={1.35} featured data-card="net">
          <Flex direction="column" gap="2">
            {/* Two figures are two totals, so the stack takes a name of its own;
                one figure is already named by the label under it. */}
            {totalNetWorth.length > 1 && (
              <Text size="2" color="gray">
                {tc("currencyTotals")}
              </Text>
            )}

            {totalNetWorth.map((total) => (
              <Flex key={total.currency} direction="column" gap="1">
                <Text size="2" color="gray">
                  {t("netWorthIn", { currency: total.currency })}
                </Text>
                <BandFigure>
                  <Money
                    minor={total.netWorthCents}
                    currency={total.currency}
                    tone={signTone(total.netWorthCents)}
                    size="inherit"
                  />
                </BandFigure>
              </Flex>
            ))}

            {(unreviewedCount > 0 || pendingDeliveryCount > 0) && (
              <Flex gap="2" wrap="wrap">
                {/* Deep-links to the ledger filtered to generated-unreviewed rows; hidden
                    once nothing awaits review (RF-31). */}
                {unreviewedCount > 0 && (
                  <PlainLink href="/movements?unreviewed=1" alignSelf="flex-start">
                    <TapTarget align="center">
                      <Badge color="amber" variant="soft" radius="full">
                        {t("unreviewedBadge", { count: unreviewedCount })}
                      </Badge>
                    </TapTarget>
                  </PlainLink>
                )}
                {pendingDeliveryCount > 0 && (
                  <PlainLink href="/inbox" alignSelf="flex-start">
                    <TapTarget align="center">
                      <Badge color="amber" variant="soft" radius="full">
                        {t("pendingDeliveriesBadge", {
                          count: pendingDeliveryCount,
                        })}
                      </Badge>
                    </TapTarget>
                  </PlainLink>
                )}
              </Flex>
            )}

            {byCurrencyBuckets(buckets).map(([currency, owners]) => (
              <Flex key={currency} direction="column" gap="2">
                <ProportionBar
                  aria-label={t("ownerBarLabel", { currency })}
                  segments={owners
                    .map((bucket, index) => ({
                      key: bucketKey(bucket),
                      value: Math.max(0, bucket.netWorthCents),
                      color: OWNER_COLORS[index % OWNER_COLORS.length],
                    }))}
                />
                <Flex gap="4" wrap="wrap">
                  {owners.map((bucket, index) => (
                    <Flex key={bucketKey(bucket)} align="center" gap="2">
                      <Disc size={10} surface={OWNER_COLORS[index % OWNER_COLORS.length]} />
                      <Text size="2" color="gray">{bucketLabel(bucket, t)}</Text>
                      <Text size="2" weight="medium">
                        <Money
                          minor={bucket.netWorthCents}
                          currency={bucket.currency}
                          tone={signTone(bucket.netWorthCents)}
                          size="inherit"
                        />
                      </Text>
                    </Flex>
                  ))}
                </Flex>
              </Flex>
            ))}
          </Flex>
        </BandCard>

        <BandCard ratio={1} data-card="month">
          <Flex direction="column" gap="4">
            {monthFlow.map((flow) => (
              <Flex key={flow.currency} direction="column" gap="2">
                {/* One currency is already named by the net-worth label beside. */}
                {monthFlow.length > 1 && (
                  <Text size="2" color="gray">
                    {tr("inCurrency", { currency: flow.currency })}
                  </Text>
                )}
                <BandStats count={flow.adjustmentCents !== 0 ? 4 : 3}>
                  <MonthStat
                    label={t("monthIncome")}
                    minor={flow.incomeCents}
                    currency={flow.currency}
                    tone="income"
                  />
                  <MonthStat
                    label={t("monthExpense")}
                    minor={flow.expenseCents}
                    currency={flow.currency}
                    tone="expense"
                    signed={false}
                  />
                  <MonthStat
                    label={t("monthNet")}
                    minor={flow.netCents}
                    currency={flow.currency}
                    tone={signTone(flow.netCents, "income")}
                  />
                  {flow.adjustmentCents !== 0 && (
                    <MonthStat
                      label={t("monthAdjustment")}
                      minor={flow.adjustmentCents}
                      currency={flow.currency}
                      tone="plain"
                      signed="always"
                    />
                  )}
                </BandStats>
              </Flex>
            ))}
          </Flex>
        </BandCard>

      </BandCards>

      <Flex gap="2" wrap="wrap">
        <Button asChild tap variant="ghost">
          <LocaleLink href="/reports">{t("viewReports")}</LocaleLink>
        </Button>
        {/* The phone's bar gave Planeación's tab to Bandeja; this is its way in. */}
        <Button asChild tap variant="ghost">
          <LocaleLink href="/planning">{tn("planning")}</LocaleLink>
        </Button>
      </Flex>
    </SummaryBand>
  );
}

// The owners' colours on the ink card: lime, a light violet, a mint, a peach.
const OWNER_COLORS = ["#c8f560", "#a78bfa", "#5eead4", "#fdba74"];

// The owner buckets regrouped per currency: a bar never mixes two of them (RF-124).
function byCurrencyBuckets(
  buckets: OwnerNetWorthNamed[],
): [CurrencyCode, OwnerNetWorthNamed[]][] {
  const groups = new Map<CurrencyCode, OwnerNetWorthNamed[]>();
  for (const bucket of buckets) {
    const group = groups.get(bucket.currency);
    if (group) group.push(bucket);
    else groups.set(bucket.currency, [bucket]);
  }
  return [...groups];
}

// A figure that can fall either way reads its sign off its own value: below zero
// it takes the expense's minus, at or above it the caller's own tone.
function signTone(cents: number, atOrAbove: MoneyTone = "plain"): MoneyTone {
  return cents < 0 ? "expense" : atOrAbove;
}

// A net-worth chip's stable key: the owner — a member's user id or the single
// group bucket — and the currency the chip counts, since an owner holding two
// wears one chip for each.
function bucketKey(bucket: OwnerNetWorthNamed): string {
  const owner =
    bucket.bucket === "group"
      ? `group:${bucket.groupId}`
      : `member:${bucket.ownerUserId}`;

  return `${owner}|${bucket.currency}`;
}

// The name a chip wears: the group's, a member's, or the self label for the
// caller's own personal-only bucket, which carries no name (RF-55).
function bucketLabel(
  bucket: OwnerNetWorthNamed,
  t: ReturnType<typeof useTranslations<"dashboard">>,
): string {
  if (bucket.bucket === "group") return bucket.name ?? t("groupLabel");
  if (bucket.isSelf && bucket.name === null) return t("selfLabel");
  return bucket.name ?? t("selfLabel");
}

// One month figure: a muted label over its amount, which carries its own sign
// and colour.
function MonthStat({
  label,
  minor,
  currency,
  tone,
  signed,
}: {
  label: string;
  minor: number;
  currency: CurrencyCode;
  tone: MoneyTone;
  signed?: boolean | "always";
}) {
  return (
    <Flex direction="column" gap="1">
      <Text size="2" color="gray">
        {label}
      </Text>
      <Text size={{ initial: "4", md: "7" }} weight={{ initial: "medium", md: "bold" }}>
        <Money
          minor={minor}
          currency={currency}
          tone={tone}
          signed={signed}
          size="inherit"
        />
      </Text>
    </Flex>
  );
}
