"use client";

import {
  createColumnHelper,
  createPaginatedRowModel,
  rowPaginationFeature,
  tableFeatures,
  useTable,
} from "@tanstack/react-table";
import type { LucideIcon } from "lucide-react";
import { CalendarDays, CircleAlert, CreditCard, Plus } from "lucide-react";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useMemo, useState } from "react";

import { DebtFormDialog } from "@/components/planning/debt-form-dialog";
import type { DebtAccount } from "@/components/planning/debt-form-dialog";
import { DebtPaymentDialog } from "@/components/planning/debt-payment-dialog";
import { DebtsTable } from "@/components/planning/debts-table";
import type { DebtTableRow } from "@/components/planning/debts-table";
import { InstallmentPlanDialog } from "@/components/planning/installment-plan-dialog";
import { PlanningSubNav } from "@/components/planning/planning-sub-nav";
import {
  Box,
  Button,
  Card,
  EmptyState,
  Flex,
  FundChip,
  Heading,
  Money,
  ScreenHeader,
  Separator,
  StatTiles,
  Text,
} from "@/components/ui";
import type { DebtCurrencyTotals, DebtsScreenData } from "@/db/queries/debts-screen";
import type { DebtOverviewRow, DebtPocket } from "@/db/queries/debt-overview";
import type { PlanPosition } from "@/db/queries/installment-plans";
import { Link as LocaleLink, useRouter } from "@/i18n/navigation";
import {
  BASE_CURRENCY,
  OFFERED_CURRENCIES,
  type CurrencyCode,
  type OfferedCurrency,
} from "@/lib/currency";
import { civilDateToDate } from "@/lib/dates";
import { formatMoney } from "@/lib/money";
import type { Locale } from "@/lib/locales";

const PAGE_SIZE = 10;

// The em dash a tile with nothing to name reads as (SPEC-A3), not a word a
// translator would ever change.
const NO_VALUE = "—";

// Paging is the only client model the table needs: the rows are ordered here and
// scoped by Postgres, so no sorting or filtering feature is registered.
const features = tableFeatures({
  rowPaginationFeature,
  paginatedRowModel: createPaginatedRowModel(),
});
const columnHelper = createColumnHelper<typeof features, DebtTableRow>();
const columns = columnHelper.columns([columnHelper.accessor("accountId", {})]);

// The dialog is one instance driven by this: which mode it opens in, for
// everything but "create" which liability it acts on, and what that liability
// bills in — every amount the dialog reads and writes is in that currency.
type DialogTarget =
  | { mode: "create" }
  | { mode: "complete"; account: DebtAccount; currency: CurrencyCode }
  | { mode: "pay"; account: DebtAccount; currency: CurrencyCode }
  | { mode: "plan"; account: DebtAccount; currency: CurrencyCode };

// A row carrying its plan position, which is what the phone's cards read.
type OverviewCard = DebtOverviewRow & {
  name: string;
  planPosition: PlanPosition | null;
};

// What the currency picker offers and what the terms schema takes. A row may
// settle in a code that reached the ledger before the list did; its terms are
// then typed in the base currency's scale, which is the one the column keeps.
function offeredCurrency(currency: CurrencyCode): OfferedCurrency {
  return (OFFERED_CURRENCIES as readonly string[]).includes(currency)
    ? (currency as OfferedCurrency)
    : BASE_CURRENCY;
}

// The pockets a debt holds beside the one it bills in, each drawn in its own
// currency and never added to the figure above it (RF-124).
function OtherOwed({
  pockets,
  locale,
}: {
  pockets: DebtPocket[];
  locale: Locale;
}) {
  return pockets.map((pocket) => (
    <Text key={pocket.currency} size="1" color="gray">
      {formatMoney(pocket.owedCents, pocket.currency, locale)}
    </Text>
  ));
}

/**
 * The consolidated debts area (RF-83, RF-117): the fund's four figures over the
 * dense table of SPEC-A3 on a laptop, and the same liabilities as cards read by
 * their `debtKind` on a phone. Every figure arrives already derived from the
 * backend and stays integer cents; the peso and percent readings are display
 * only. One `DebtFormDialog` serves the header's "new debt" and each bare
 * liability's "complete terms", and the same target state opens the payment
 * (RF-16, RF-82) and the plan (RF-81).
 */
export function DebtsScreen({
  data,
  hasGroup,
}: {
  data: DebtsScreenData;
  hasGroup: boolean;
}) {
  const t = useTranslations("debts");
  const tKey = useTranslations();
  const format = useFormatter();
  const locale = useLocale() as Locale;
  const router = useRouter();

  const [target, setTarget] = useState<DialogTarget | null>(null);

  const { totals, withTerms, withoutTerms, payFrom } = data;
  const isEmpty = withTerms.length === 0 && withoutTerms.length === 0;
  const debtCount = withTerms.length + withoutTerms.length;

  function shortDate(date: string): string {
    return format.dateTime(civilDateToDate(date), {
      day: "numeric",
      month: "short",
    });
  }

  function payTarget(account: DebtAccount, currency: CurrencyCode) {
    setTarget({ mode: "pay", account, currency });
  }

  // The table sorts nothing: the rows arrive here in the order its due-date
  // column inks as sorted, the debts with no date last, then by name.
  const rows = useMemo<DebtTableRow[]>(() => {
    const all: DebtTableRow[] = [
      ...withTerms.map((row) => ({
        accountId: row.accountId,
        name: row.name,
        currency: row.currency,
        owedCents: row.owedCents,
        otherOwed: row.otherOwed,
        planPosition: row.planPosition,
        terms: row,
        canWrite: row.canWrite,
      })),
      ...withoutTerms.map((debt) => ({ ...debt, terms: null })),
    ];

    return all.sort((a, b) => {
      const left = a.terms?.nextDueDate ?? null;
      const right = b.terms?.nextDueDate ?? null;
      if (left !== right) {
        if (left === null) return 1;
        if (right === null) return -1;
        return left < right ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });
  }, [withTerms, withoutTerms]);

  const table = useTable(
    {
      features,
      data: rows,
      columns,
      initialState: { pagination: { pageIndex: 0, pageSize: PAGE_SIZE } },
    },
    (state) => ({ pagination: state.pagination }),
  );

  const pageRows = table.getPaginatedRowModel().rows.map((row) => row.original);

  const addButton = (
    <Button type="button" onClick={() => setTarget({ mode: "create" })}>
      <Plus size={16} />
      {t("add")}
    </Button>
  );

  // The table's own slot: inside its frame the stack keeps its own height, so
  // the column headers stay on screen.
  const tableEmpty = (
    <EmptyState
      variant="filtered"
      title={t("emptyTitle")}
      description={t("emptyDescription")}
      action={addButton}
    />
  );

  // Every set the fund's debts add up to, one currency each, and the label each
  // one is read under. A single-currency fund is its own label, so it keeps the
  // bare band it has always had.
  const currencySets = totals.byCurrency;
  const manyCurrencies = currencySets.length > 1;

  function currencyLabel(currency: CurrencyCode): string {
    return tKey("planning.inCurrency", { currency });
  }

  // The four figures of the artboard, struck IN ONE CURRENCY: every one of them
  // arrives derived — the rate is the backend's own share of that currency's
  // balance and the cupo its own sum over the debts that carry a limit and bill
  // in it — so no tile can disagree with the column it sits over, and none of
  // them counts a figure booked in another currency (RF-124).
  //
  // The next payment falls in the currency the paying debt bills in, so it sits
  // in that set alone rather than under every one of them.
  function tilesFor(set: DebtCurrencyTotals) {
    const nextPayment =
      totals.nextPayment !== null && totals.nextPayment.currency === set.currency
        ? totals.nextPayment
        : null;

    return [
      {
        key: "total",
        label: t("tileTotal"),
        value: (
          <Money
            minor={set.owedCents}
            currency={set.currency}
            signed={false}
            size="inherit"
          />
        ),
        note: t("tileTotalNote", { count: set.debtCount }),
      },
      {
        key: "interest",
        label: t("tileMonthlyInterest"),
        value: (
          <Money
            minor={set.monthlyInterestCents}
            currency={set.currency}
            signed={false}
            size="inherit"
          />
        ),
        note: t("tileMonthlyInterestNote", {
          pct: format.number(set.monthlyRatePct, {
            style: "percent",
            minimumFractionDigits: 1,
            maximumFractionDigits: 1,
          }),
        }),
      },
      {
        key: "nextPayment",
        label: t("tileNextPayment"),
        value:
          nextPayment === null ? (
            NO_VALUE
          ) : (
            <Money
              minor={nextPayment.amountCents}
              currency={nextPayment.currency}
              signed={false}
              size="inherit"
            />
          ),
        note:
          nextPayment === null
            ? undefined
            : t("tileNextPaymentNote", {
                date: shortDate(nextPayment.date),
                name: nextPayment.name,
              }),
      },
      {
        key: "availableCredit",
        label: t("tileAvailableCredit"),
        // Absent, not a zero, when no debt billing in this currency carries a
        // limit: a cupo nobody granted is not a cupo spent (RF-117).
        value:
          set.availableCreditCents === null ? (
            NO_VALUE
          ) : (
            <Money
              minor={set.availableCreditCents}
              currency={set.currency}
              signed={false}
              size="inherit"
            />
          ),
        note:
          set.creditLimitCents === null
            ? undefined
            : t("tileAvailableCreditNote", {
                amount: formatMoney(set.creditLimitCents, set.currency, locale),
              }),
      },
    ];
  }

  return (
    <Flex direction="column" gap="4">
      {/* The laptop's band and table, and the phone's header and cards: exactly
          one set is displayed at any width. */}
      <Box display={{ initial: "none", lg: "block" }}>
        <ScreenHeader
          title={t("title")}
          meta={
            totals.nextPayment === null
              ? t("listMetaNoPayment", { count: debtCount })
              : t("listMeta", {
                  count: debtCount,
                  date: shortDate(totals.nextPayment.date),
                })
          }
          actions={
            <Button
              type="button"
              variant="surface"
              color="gray"
              onClick={() => setTarget({ mode: "create" })}
            >
              <Plus size={15} />
              {t("add")}
            </Button>
          }
        />
        <Box display={{ initial: "none", md: "block" }}>
          <PlanningSubNav />
        </Box>
        {/* One labelled set per currency, none of them summing another: a card
            that bills in pesos and buys in dollars owes in both (RF-124). */}
        <Flex direction="column" gap="3">
          {manyCurrencies && (
            <Heading as="h2" size="3">
              {tKey("common.currencyTotals")}
            </Heading>
          )}
          {currencySets.map((set) => (
            <Flex key={set.currency} direction="column" gap="2">
              {manyCurrencies && (
                <Text size="2" color="gray">
                  {currencyLabel(set.currency)}
                </Text>
              )}
              <StatTiles tiles={tilesFor(set)} />
            </Flex>
          ))}
        </Flex>
        <DebtsTable
          rows={pageRows}
          // The fund's next payment, so the badge names the same debt on every
          // page rather than each page's own earliest.
          nextPaymentAccountId={totals.nextPayment?.accountId ?? null}
          page={table.state.pagination.pageIndex + 1}
          pageSize={PAGE_SIZE}
          total={rows.length}
          empty={tableEmpty}
          onPrev={() => table.previousPage()}
          onNext={() => table.nextPage()}
          onPay={(row) =>
            payTarget(
              {
                accountId: row.accountId,
                name: row.name,
                owedCents: row.owedCents,
              },
              row.currency,
            )
          }
          onNewPlan={(row) =>
            setTarget({
              mode: "plan",
              account: {
                accountId: row.accountId,
                name: row.name,
                owedCents: row.owedCents,
              },
              currency: row.currency,
            })
          }
          onDetail={(row) => router.push(`/planning/debts/${row.accountId}`)}
          onEditTerms={(row) =>
            setTarget({
              mode: "complete",
              account: {
                accountId: row.accountId,
                name: row.name,
                owedCents: row.owedCents,
              },
              currency: row.currency,
            })
          }
        />
      </Box>

      <Box display={{ initial: "block", lg: "none" }}>
        <Flex direction="column" gap="4">
          <Flex justify="between" align="center" gap="3" wrap="wrap">
            <Flex align="center" gap="2">
              <Heading size="5">{t("title")}</Heading>
              {hasGroup && <FundChip label={tKey("fund.label")} />}
            </Flex>
            {addButton}
          </Flex>

          <Box display={{ initial: "none", md: "block" }}>
            <PlanningSubNav />
          </Box>

          {/* The same labelled sets the laptop's band draws, stacked (RF-124). */}
          <Flex direction="column" gap="4">
            {manyCurrencies && (
              <Text size="2" weight="medium">
                {tKey("common.currencyTotals")}
              </Text>
            )}
            {currencySets.map((set) => (
              <Flex key={set.currency} direction="column" gap="1">
                <Text size="2" color="gray">
                  {manyCurrencies
                    ? `${t("total")} · ${currencyLabel(set.currency)}`
                    : t("total")}
                </Text>
                <Heading
                  as="h2"
                  size="8"
                  style={{ fontVariantNumeric: "tabular-nums" }}
                >
                  {formatMoney(set.owedCents, set.currency, locale)}
                </Heading>
                {totals.nextPayment !== null &&
                  totals.nextPayment.currency === set.currency && (
                    <Text size="2" color="gray">
                      {t("nextPayment", {
                        amount: formatMoney(
                          totals.nextPayment.amountCents,
                          totals.nextPayment.currency,
                          locale,
                        ),
                        date: format.dateTime(
                          civilDateToDate(totals.nextPayment.date),
                          { day: "numeric", month: "short" },
                        ),
                      })}
                    </Text>
                  )}
                <Text size="2" color="gray">
                  {t("monthlyInterest", {
                    amount: formatMoney(
                      set.monthlyInterestCents,
                      set.currency,
                      locale,
                    ),
                  })}
                </Text>
              </Flex>
            ))}
          </Flex>

          {isEmpty ? (
            <EmptyState
              title={t("emptyTitle")}
              description={t("emptyDescription")}
              action={addButton}
            />
          ) : (
            <Flex direction="column" gap="3">
              {withTerms.map((row) => {
                const onPay = row.canWrite
                  ? () =>
                      payTarget(
                        {
                          accountId: row.accountId,
                          name: row.name,
                          owedCents: row.owedCents,
                        },
                        row.currency,
                      )
                  : undefined;

                return row.debtKind === "revolving" ? (
                  <RevolvingCard key={row.accountId} row={row} onPay={onPay} />
                ) : (
                  <InstallmentCard key={row.accountId} row={row} onPay={onPay} />
                );
              })}
              {withoutTerms.map((debt) => (
                <NoTermsCard
                  key={debt.accountId}
                  debt={debt}
                  onComplete={
                    debt.canWrite
                      ? () =>
                          setTarget({
                            mode: "complete",
                            account: {
                              accountId: debt.accountId,
                              name: debt.name,
                              owedCents: debt.owedCents,
                            },
                            currency: debt.currency,
                          })
                      : undefined
                  }
                  onPay={
                    debt.canWrite
                      ? () =>
                          payTarget(
                            {
                              accountId: debt.accountId,
                              name: debt.name,
                              owedCents: debt.owedCents,
                            },
                            debt.currency,
                          )
                      : undefined
                  }
                />
              ))}
            </Flex>
          )}
        </Flex>
      </Box>

      <DebtFormDialog
        open={target?.mode === "create" || target?.mode === "complete"}
        onOpenChange={(open) => {
          if (!open) setTarget(null);
        }}
        mode={target?.mode === "complete" ? "complete" : "create"}
        hasGroup={hasGroup}
        account={target?.mode === "complete" ? target.account : undefined}
        // The terms are typed in the minor unit of what the card bills in
        // (RF-121). A new debt picks its own currency, so the create mode falls
        // back to the base one.
        currency={
          target?.mode === "complete"
            ? offeredCurrency(target.currency)
            : BASE_CURRENCY
        }
      />

      {target?.mode === "pay" && (
        <DebtPaymentDialog
          open
          onOpenChange={(open) => {
            if (!open) setTarget(null);
          }}
          debt={target.account}
          currency={target.currency}
          payFrom={payFrom}
        />
      )}

      {target?.mode === "plan" && (
        <InstallmentPlanDialog
          open
          onOpenChange={(open) => {
            if (!open) setTarget(null);
          }}
          account={{
            id: target.account.accountId,
            name: target.account.name,
          }}
          currency={target.currency}
        />
      )}
    </Flex>
  );
}

// A soft tinted disc carrying the card's icon, matching the hub's rows.
function Disc({ icon: Icon, tint }: { icon: LucideIcon; tint: string }) {
  return (
    <Flex
      align="center"
      justify="center"
      style={{
        width: 42,
        height: 42,
        borderRadius: "var(--radius-5)",
        background: `var(--${tint}-a3)`,
        color: `var(--${tint}-11)`,
        flexShrink: 0,
      }}
    >
      <Icon size={20} />
    </Flex>
  );
}

// The head row every card shares: disc, name over a meta line, owed on the
// right — the pocket the debt bills in, and under it what it owes in a currency
// it does not, each drawn in its own and never added to the other (RF-124).
function CardHead({
  icon,
  tint,
  name,
  meta,
  currency,
  owedCents,
  otherOwed,
}: {
  icon: LucideIcon;
  tint: string;
  name: string;
  meta: string;
  currency: CurrencyCode;
  owedCents: number;
  otherOwed: DebtPocket[];
}) {
  const locale = useLocale() as Locale;

  return (
    <Flex align="center" gap="3">
      <Disc icon={icon} tint={tint} />
      <Flex direction="column" style={{ flex: 1, minWidth: 0 }}>
        <Text weight="bold" truncate>
          {name}
        </Text>
        <Text size="1" color="gray">
          {meta}
        </Text>
      </Flex>
      <Flex direction="column" align="end" style={{ fontVariantNumeric: "tabular-nums" }}>
        <Text weight="bold">{formatMoney(owedCents, currency, locale)}</Text>
        <OtherOwed pockets={otherOwed} locale={locale} />
      </Flex>
    </Flex>
  );
}

// A footer label over its value; the value already reads as a formatted string.
function Stat({
  label,
  value,
  align,
}: {
  label: string;
  value: string;
  align?: "right";
}) {
  return (
    <Flex direction="column" gap="1" style={align ? { textAlign: "right" } : undefined}>
      <Text size="1" color="gray">
        {label}
      </Text>
      <Text size="2" weight="medium" style={{ fontVariantNumeric: "tabular-nums" }}>
        {value}
      </Text>
    </Flex>
  );
}

/**
 * The card's footer. Reading a debt is offered to everyone it is shown to, so
 * the door onto its cuotas and its extractos is never gated — the phone has no
 * other way in (RF-58, RF-81, RF-84). The abono is the caller's own privilege
 * and arrives absent when the policies would refuse it (RF-16).
 */
function CardActions({
  accountId,
  onPay,
}: {
  accountId: string;
  onPay?: () => void;
}) {
  const t = useTranslations("debts");

  return (
    <Flex justify="end" align="center" gap="2">
      <Button asChild tap variant="ghost" size="2" color="gray">
        <LocaleLink href={`/planning/debts/${accountId}`}>
          {t("rowDetail")}
        </LocaleLink>
      </Button>
      {onPay && (
        <Button type="button" tap variant="ghost" size="2" onClick={onPay}>
          {t("rowPay")}
        </Button>
      )}
    </Flex>
  );
}

function RevolvingCard({
  row,
  onPay,
}: {
  row: OverviewCard;
  onPay?: () => void;
}) {
  const t = useTranslations("debts");
  const format = useFormatter();
  const locale = useLocale() as Locale;

  const hasFooter =
    row.minimumPaymentCents !== null ||
    row.nextCutOffDate !== null ||
    row.availableCreditCents !== null;

  return (
    <Card>
      <Flex direction="column" gap="3">
        <CardHead
          icon={CreditCard}
          tint="indigo"
          name={row.name}
          meta={t("revolvingMeta", {
            // The effective monthly step the server derived off the annual rate,
            // read as a percentage here and nowhere divided, so the card and the
            // row can never state the rate a hair apart.
            pct: format.number(row.monthlyRatePct, {
              style: "percent",
              minimumFractionDigits: 1,
              maximumFractionDigits: 1,
            }),
          })}
          currency={row.currency}
          owedCents={row.owedCents}
          otherOwed={row.otherOwed}
        />

        {hasFooter && (
          <>
            <Separator size="4" />
            {(row.minimumPaymentCents !== null ||
              row.nextCutOffDate !== null) && (
              <Flex justify="between" gap="3">
                {row.minimumPaymentCents !== null && (
                  <Stat
                    label={t("minimumPayment")}
                    value={formatMoney(
                      row.minimumPaymentCents,
                      row.currency,
                      locale,
                    )}
                  />
                )}
                {row.nextCutOffDate !== null && (
                  <Stat
                    align="right"
                    label={t("cutOff")}
                    value={format.dateTime(
                      civilDateToDate(row.nextCutOffDate),
                      { day: "numeric", month: "short" },
                    )}
                  />
                )}
              </Flex>
            )}
            {row.availableCreditCents !== null && (
              <Text size="1" color="gray">
                {t("availableCredit", {
                  amount: formatMoney(
                    row.availableCreditCents,
                    row.currency,
                    locale,
                  ),
                })}
              </Text>
            )}
          </>
        )}

        <CardActions accountId={row.accountId} onPay={onPay} />
      </Flex>
    </Card>
  );
}

function InstallmentCard({
  row,
  onPay,
}: {
  row: OverviewCard;
  onPay?: () => void;
}) {
  const t = useTranslations("debts");
  const format = useFormatter();
  const locale = useLocale() as Locale;

  const position = row.planPosition;
  const nextLine =
    position !== null &&
    position.nextDueDate !== null &&
    position.nextAmountCents !== null
      ? { date: position.nextDueDate, amountCents: position.nextAmountCents }
      : null;

  return (
    <Card>
      <Flex direction="column" gap="3">
        <CardHead
          icon={CalendarDays}
          tint="amber"
          name={row.name}
          // A debt whose plan the server counted states its position; one that
          // carries no plan only states its kind (RF-81).
          meta={
            position === null
              ? t("installmentMeta")
              : t("installmentPosition", {
                  paid: position.linesPaid,
                  total: position.linesTotal,
                })
          }
          currency={row.currency}
          owedCents={row.owedCents}
          otherOwed={row.otherOwed}
        />

        <Separator size="4" />
        <Flex justify="between" gap="3">
          <Stat
            label={t("dueInstallments")}
            value={formatMoney(row.dueInstallmentsCents, row.currency, locale)}
          />
          {row.nextDueDate !== null && (
            <Stat
              align="right"
              label={t("dueDate")}
              value={format.dateTime(civilDateToDate(row.nextDueDate), {
                day: "numeric",
                month: "short",
              })}
            />
          )}
        </Flex>

        {nextLine && (
          <Flex justify="between" align="center" gap="3">
            <Text size="1" color="gray">
              {t("nextInstallment", {
                date: format.dateTime(civilDateToDate(nextLine.date), {
                  day: "numeric",
                  month: "short",
                }),
              })}
            </Text>
            <Text size="2" weight="medium">
              <Money
                minor={nextLine.amountCents}
                currency={row.currency}
                signed={false}
                size="inherit"
              />
            </Text>
          </Flex>
        )}

        <CardActions accountId={row.accountId} onPay={onPay} />
      </Flex>
    </Card>
  );
}

function NoTermsCard({
  debt,
  onComplete,
  onPay,
}: {
  debt: {
    accountId: string;
    name: string;
    currency: CurrencyCode;
    owedCents: number;
    otherOwed: DebtPocket[];
  };
  // Absent for a caller who cannot write the debt: the head already says what it
  // lacks, and the invitation would only lead to a refusal.
  onComplete?: () => void;
  onPay?: () => void;
}) {
  const t = useTranslations("debts");

  return (
    <Card>
      <Flex direction="column" gap="3">
        <CardHead
          icon={CircleAlert}
          tint="amber"
          name={debt.name}
          meta={t("noTermsMeta")}
          currency={debt.currency}
          owedCents={debt.owedCents}
          otherOwed={debt.otherOwed}
        />
        {onComplete && (
          <Button
            type="button"
            variant="soft"
            color="amber"
            onClick={onComplete}
          >
            {t("completeTerms")}
          </Button>
        )}
        <CardActions accountId={debt.accountId} onPay={onPay} />
      </Flex>
    </Card>
  );
}
