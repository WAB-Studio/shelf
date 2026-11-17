"use client";

import { useTranslations } from "next-intl";

import {
  BandCard,
  BandCards,
  BandFigure,
  BandStats,
  Badge,
  Button,
  Dialog,
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
import type { MonthAdjustment } from "@/db/queries/home-lines";
import type { DashboardData } from "@/db/queries/reports/dashboard";
import type { OwnerNetWorthNamed } from "@/db/queries/reports/dashboard";
import { PrivacyToggle } from "@/components/fund/privacy-toggle";
import { Link as LocaleLink } from "@/i18n/navigation";
import type { CurrencyCode } from "@/lib/currency";
import type { Holding } from "@/lib/fund/home-lines";

/**
 * The home dashboard's headline: what is in the person's accounts as the big figure, the net worth under it
 * small and opening its sum, over a pill per owner (RF-88), the group counting as one bucket rather than split across its members
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
export function DashboardSummary({
  data,
  holdings,
  adjustments,
}: {
  data: DashboardData;
  holdings: Holding[];
  // The month's adjustments account by account, the rows the «Ajuste por cuadre» total is the sum of.
  adjustments: MonthAdjustment[];
}) {
  const t = useTranslations("dashboard");
  const tc = useTranslations("common");
  const tr = useTranslations("reports");
  const tn = useTranslations("nav");

  const { netWorth, monthFlow, unreviewedCount } = data;

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
            {holdings.length > 1 && (
              <Text size="2" color="gray">
                {tc("currencyTotals")}
              </Text>
            )}

            {holdings.map((holding, index) => (
              <Flex key={holding.currency} direction="column" gap="1">
                {/* One switch for the whole app, on the first figure's label row. */}
                <Flex align="center" justify="between" gap="2">
                  <Text size="2" color="gray">
                    {holdings.length > 1 ? t("haveLabelIn", { currency: holding.currency }) : t("haveLabel")}
                  </Text>
                  {index === 0 && <PrivacyToggle />}
                </Flex>
                <BandFigure
                  minor={holding.haveCents}
                  currency={holding.currency}
                  tone={signTone(holding.haveCents)}
                />
                <NetWorthSum holding={holding} />
              </Flex>
            ))}

            {unreviewedCount > 0 && (
              <Flex gap="2" wrap="wrap">
                {/* Deep-links to the ledger filtered to generated-unreviewed rows; hidden
                    once nothing awaits review (RF-31). */}
                <PlainLink href="/movements?unreviewed=1" alignSelf="flex-start">
                  <TapTarget align="center">
                    <Badge color="amber" variant="soft" radius="full">
                      {t("unreviewedBadge", { count: unreviewedCount })}
                    </Badge>
                  </TapTarget>
                </PlainLink>
              </Flex>
            )}

            {byCurrencyBuckets(buckets).map(([currency, owners]) => {
              // Only what is owned has a share of the bar; a bucket below zero is listed
              // beside it, with its sign.
              const owned = owners.filter((bucket) => bucket.netWorthCents > 0);
              const colorOf = (bucket: OwnerNetWorthNamed) =>
                bucket.netWorthCents > 0
                  ? OWNER_COLORS[owned.indexOf(bucket) % OWNER_COLORS.length]
                  : "var(--gray-9)";

              return (
                <Flex key={currency} direction="column" gap="2">
                  {owned.length > 0 && (
                    <ProportionBar
                      aria-label={t("ownerBarLabel", { currency })}
                      segments={owned.map((bucket) => ({
                        key: bucketKey(bucket),
                        value: bucket.netWorthCents,
                        color: colorOf(bucket),
                      }))}
                    />
                  )}
                  <Flex gap="4" wrap="wrap">
                    {owners.map((bucket) => (
                      <Flex key={bucketKey(bucket)} align="center" gap="2">
                        <Disc size={10} surface={colorOf(bucket)} />
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
              );
            })}
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
                    <AdjustmentStat
                      flow={flow}
                      rows={adjustments.filter((row) => row.currency === flow.currency)}
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
        {/* The phone's bar holds no Planeación tab; this and Ajustes are its way in. */}
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

// The net worth, small under the figure of what is in the accounts: a button that opens the sum it comes from.
function NetWorthSum({ holding }: { holding: Holding }) {
  const t = useTranslations("dashboard");
  const { currency, haveCents, owedToMeCents, owesCents, netCents } = holding;

  return (
    <Dialog.Root>
      <Dialog.Trigger>
        <Button variant="ghost" color="gray" size="1" tap>
          {t.rich("netSeeLabel", {
            amount: () => <Money minor={netCents} currency={currency} size="inherit" />,
          })}
        </Button>
      </Dialog.Trigger>
      <Dialog.Content>
        <Dialog.Title>{t("netTitle")}</Dialog.Title>
        <Flex direction="column" gap="3">
          <SumRow label={t("netHave")} minor={haveCents} currency={currency} />
          {owedToMeCents !== 0 && (
            <SumRow label={t("netOwedToMe")} minor={owedToMeCents} currency={currency} signed="always" />
          )}
          {owesCents !== 0 && <SumRow label={t("netOwes")} minor={-owesCents} currency={currency} signed="always" />}
          <SumRow label={t("netTotal")} minor={netCents} currency={currency} bold />
          <Flex justify="end">
            <Dialog.Close>
              <Button type="button" variant="soft" color="gray">
                {t("close")}
              </Button>
            </Dialog.Close>
          </Flex>
        </Flex>
      </Dialog.Content>
    </Dialog.Root>
  );
}

// One line of a sum: its words and its figure.
function SumRow({
  label,
  minor,
  currency,
  signed,
  bold,
}: {
  label: string;
  minor: number;
  currency: CurrencyCode;
  signed?: boolean | "always";
  bold?: boolean;
}) {
  return (
    <Flex justify="between" align="baseline" gap="3">
      <Text size="2" weight={bold ? "bold" : undefined}>
        {label}
      </Text>
      <Text size="2" weight={bold ? "bold" : "medium"}>
        <Money minor={minor} currency={currency} signed={signed} size="inherit" />
      </Text>
    </Flex>
  );
}

// «Ajuste por cuadre del mes»: the total, tappable, opening each account and what its count moved.
function AdjustmentStat({ flow, rows }: { flow: DashboardData["monthFlow"][number]; rows: MonthAdjustment[] }) {
  const t = useTranslations("dashboard");

  const stat = (
    <MonthStat
      label={t("monthAdjustment")}
      minor={flow.adjustmentCents}
      currency={flow.currency}
      tone="plain"
      signed="always"
    />
  );
  if (rows.length === 0) return stat;

  return (
    <Dialog.Root>
      <Dialog.Trigger>
        <Button variant="ghost" color="gray">
          {stat}
        </Button>
      </Dialog.Trigger>
      <Dialog.Content>
        <Dialog.Title>{t("adjustmentTitle")}</Dialog.Title>
        <Flex direction="column" gap="3">
          <Text size="2" color="gray">
            {t("adjustmentHint")}
          </Text>
          {rows.map((row) => (
            <SumRow
              key={`${row.accountName}|${row.currency}`}
              label={row.accountName}
              minor={row.cents}
              currency={row.currency as CurrencyCode}
              signed="always"
            />
          ))}
          <SumRow label={t("adjustmentTotal")} minor={flow.adjustmentCents} currency={flow.currency} signed="always" bold />
          <Flex justify="end">
            <Dialog.Close>
              <Button type="button" variant="soft" color="gray">
                {t("close")}
              </Button>
            </Dialog.Close>
          </Flex>
        </Flex>
      </Dialog.Content>
    </Dialog.Root>
  );
}
