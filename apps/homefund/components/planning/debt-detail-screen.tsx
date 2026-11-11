"use client";

import type { ReactNode } from "react";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { Fragment, useState } from "react";

import { DeferredPurchases } from "@/components/planning/deferral-control";
import { OwnerMark } from "@/components/fund/owner-mark";
import { DebtPaymentDialog } from "@/components/planning/debt-payment-dialog";
import {
  CreditAndOwedLine,
  owesBesideCredit,
  PocketFigure,
} from "@/components/planning/debts-table";
import { SettlementRow } from "@/components/planning/settlement-row";
import { StatementsSection } from "@/components/planning/statements-section";
import {
  Button,
  EmptyState,
  Flex,
  Heading,
  Money,
  Panel,
  ScreenHeader,
  Separator,
  StatTiles,
  Text,
} from "@/components/ui";
import type { DebtDetailData } from "@/db/queries/debt-detail";
import type { DebtPocket } from "@/db/queries/debt-overview";
import type { PendingSettlement } from "@/db/queries/debt-statements";
import type { CurrencyCode } from "@/lib/currency";
import { civilDateToDate, todayInBogota } from "@/lib/dates";
import { useMoneyText } from "@/lib/use-privacy";

// The em dash a cell or a tile with nothing to name reads as (SPEC-A3), not a
// word a translator would ever change.
const NO_VALUE = "—";

/**
 * One liability read in full (RF-16, RF-129, RF-136): its derived saldo over
 * the four figures it owes against, the purchases a person deferred, and its statement history under the
 * open period. Every figure arrives derived from the server — the stored
 * statement balances are read exactly as they were frozen at their cut-off, and
 * no interest is recomputed here. A caller the policies would refuse is offered
 * no action at all (`canWrite`).
 */
export function DebtDetailScreen({ data }: { data: DebtDetailData }) {
  const moneyText = useMoneyText();
  const t = useTranslations("installments");
  const tDebts = useTranslations("debts");
  const format = useFormatter();
  const locale = useLocale();

  const {
    account,
    terms,
    deferrals,
    statements,
    currentStatement,
    pendingSettlements,
    canWrite,
    payFrom,
  } = data;

  // The currency the card bills in: the cupo, the minimum and the interest are
  // all read in it, and it is the one a statement is cut in (RF-121).
  const currency = account.settlementCurrency;

  const [dialog, setDialog] = useState<"pay" | null>(null);
  // The pocket it bills in, read by its sign off the balance the view derives
  // from movements: below zero it owes, above zero it holds a credit that owes
  // nothing and reads «A favor» (RF-80).
  const owedCents = Math.max(0, -account.balanceCents);
  const creditCents = Math.max(0, account.balanceCents);

  // The pockets in other currencies, as the list reads them off the overview.
  const otherOwed: DebtPocket[] = account.balances
    .filter((pocket) => pocket.currency !== account.settlementCurrency)
    .map((pocket) => ({
      currency: pocket.currency as CurrencyCode,
      owedCents: Math.max(0, -pocket.balanceCents),
      creditCents: Math.max(0, pocket.balanceCents),
      toBillCents: pocket.toBillCents,
    }));

  // The limit plus the signed pocket, the figure the list states: a credit
  // lifts the cupo past the limit. With no limit there is no cupo, which is not
  // the same as a cupo of zero (RF-117).
  const availableCreditCents =
    terms?.creditLimitCents == null
      ? null
      : terms.creditLimitCents + account.balanceCents;

  // A debt that owes nothing has no minimum to pay, whatever its terms say.
  const nextPayment =
    currentStatement === null ||
    currentStatement.nextDueDate === null ||
    owedCents === 0
      ? null
      : {
          amountCents: currentStatement.minimumPaymentCents,
          date: currentStatement.nextDueDate,
        };

  function shortDate(date: string): string {
    return format.dateTime(civilDateToDate(date), {
      day: "numeric",
      month: "short",
    });
  }

  // Credit with a pocket owed reads the row's whole Q9 line (Q18 a); a card
  // whose pesos are at zero while another pocket owes names it «Debes».
  const beside = owesBesideCredit(creditCents, otherOwed);
  const onlyForeign =
    owedCents === 0 && creditCents === 0 && otherOwed.some((pocket) => pocket.owedCents > 0);
  // Every pocket the line does not already read, in its own currency and never
  // summed (RF-124).
  const pockets = beside
    ? otherOwed.filter((pocket) => pocket.creditCents > 0)
    : onlyForeign
      ? otherOwed
      : account.balances.map((pocket) => ({
          currency: pocket.currency,
          owedCents: Math.max(0, -pocket.balanceCents),
          creditCents: Math.max(0, pocket.balanceCents),
        }));

  // The header and the «Saldo» tile read the same line.
  const balanceLine = (
    <Flex direction="column">
      {beside && (
        <CreditAndOwedLine
          creditCents={creditCents}
          currency={currency}
          otherOwed={otherOwed}
          align="left"
          inherit
        />
      )}
      {pockets.map((pocket) => (
        <PocketFigure
          key={pocket.currency}
          owedCents={pocket.owedCents}
          creditCents={pocket.creditCents}
          currency={pocket.currency}
          inherit
          named={onlyForeign}
        />
      ))}
    </Flex>
  );

  const tiles = [
    {
      key: "balance",
      label: tDebts("tableBalance"),
      value: balanceLine,
    },
    {
      key: "nextPayment",
      label: tDebts("tileNextPayment"),
      // The open period's own minimum, derived by the server on the live
      // balance; a debt with no due day names no next payment.
      value:
        nextPayment === null ? (
          NO_VALUE
        ) : (
          <Money
            minor={nextPayment.amountCents}
            currency={currency}
            signed={false}
            size="inherit"
          />
        ),
      note: nextPayment === null ? tDebts("tileNoNextPayment") : shortDate(nextPayment.date),
    },
    {
      key: "availableCredit",
      label: tDebts("tileAvailableCredit"),
      value:
        availableCreditCents === null ? (
          NO_VALUE
        ) : (
          <Money
            minor={availableCreditCents}
            currency={currency}
            signed={false}
            size="inherit"
          />
        ),
      note:
        terms?.creditLimitCents == null
          ? undefined
          : tDebts("tileAvailableCreditNote", {
              // JSX cannot travel through `t()`, so the one path from a stored
              // integer to a figure is called straight (RF-121).
              amount: moneyText(terms.creditLimitCents, currency, locale),
            }),
    },
  ];

  return (
    <Flex direction="column" gap="4">
      <ScreenHeader
        title={account.name}
        meta={
          <>
            <OwnerMark foreignOwner={account.foreignOwner} ownerName={account.ownerName} />
            {balanceLine}
          </>
        }
        metaWraps
        back={{ href: "/planning/debts", label: tDebts("title") }}
        actions={
          // Exactly what the policies would admit: a reader is offered no abono,
          // and no row menu below offers the delete.
          canWrite && (
            <Button
              type="button"
              variant="surface"
              color="gray"
              onClick={() => setDialog("pay")}
            >
              {tDebts("rowPay")}
            </Button>
          )
        }
      />

      <StatTiles tiles={tiles} />

      {/* Purchases a person confirmed as deferred: the balance holds them whole (RF-136). */}
      {deferrals.length > 0 && (
        <Flex direction="column" px={{ initial: "0", md: "6" }}>
          <DeferredPurchases rows={deferrals} />
        </Flex>
      )}

      <SettlementSection
        accountId={account.id}
        currency={currency}
        pending={pendingSettlements}
        canWrite={canWrite}
      />

      {/* The period nobody has cut yet: live figures, and never one of the
          snapshots below (RF-129). */}
      {currentStatement !== null && (
        <Flex direction="column" px={{ initial: "0", md: "6" }}>
          <Panel title={t("currentPeriod")}>
            <Flex direction="column" px="4" py="1">
              <Fact
                label={t("periodStart")}
                value={shortDate(currentStatement.periodStart)}
              />
              <Separator size="4" />
              <Fact
                label={t("statementBalance")}
                value={
                  <PocketFigure
                    owedCents={Math.max(0, -currentStatement.balanceCents)}
                    creditCents={Math.max(0, currentStatement.balanceCents)}
                    currency={currency}
                    inherit
                  />
                }
              />
              {currentStatement.balanceCents < 0 && (
                <>
                  <Separator size="4" />
                  <Fact
                    label={t("statementMinimum")}
                    value={
                      <Money
                        minor={currentStatement.minimumPaymentCents}
                        currency={currency}
                        signed={false}
                        size="inherit"
                      />
                    }
                  />
                </>
              )}
              {currentStatement.nextCutOffDate !== null && (
                <>
                  <Separator size="4" />
                  <Fact
                    label={t("statementCutOff")}
                    value={shortDate(currentStatement.nextCutOffDate)}
                  />
                </>
              )}
              {currentStatement.nextDueDate !== null && (
                <>
                  <Separator size="4" />
                  <Fact
                    label={t("statementDueDate")}
                    value={shortDate(currentStatement.nextDueDate)}
                  />
                </>
              )}
            </Flex>
          </Panel>
        </Flex>
      )}

      <StatementsSection
        account={{
          id: account.id,
          name: account.name,
          kind: "liability",
          nextPeriodStart: currentStatement?.periodStart ?? todayInBogota(),
        }}
        currency={currency}
        statements={statements}
        canWrite={canWrite}
      />

      {dialog === "pay" && (
        <DebtPaymentDialog
          open
          onOpenChange={(open) => {
            if (!open) setDialog(null);
          }}
          debt={{
            accountId: account.id,
            name: account.name,
            owedCents,
            creditCents,
            otherOwed,
          }}
          currency={currency}
          payFrom={payFrom}
        />
      )}

    </Flex>
  );
}

// One line of the open period: what it is on the left, what it says on the right.
function Fact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <Flex align="center" justify="between" gap="4" py="3">
      <Text size="2" color="gray">
        {label}
      </Text>
      <Text size="2" weight="medium" align="right">
        {value}
      </Text>
    </Flex>
  );
}

/**
 * The purchases the issuer has not billed yet (RF-123): what was spent, in the
 * currency it was spent in, beside what a person expects it to cost, marked an
 * estimate. A row leaves the list the moment the billed amount lands — the mark
 * is what moves the amount from the foreign pocket to the settlement one, and the
 * derived balance does the moving, never this screen.
 */
function SettlementSection({
  accountId,
  currency,
  pending,
  canWrite,
}: {
  accountId: string;
  currency: CurrencyCode;
  pending: PendingSettlement[];
  canWrite: boolean;
}) {
  const t = useTranslations("debts.settlement");

  return (
    <>
      <Flex direction="column" px={{ initial: "0", md: "6" }}>
        <Heading as="h2" size="3">
          {t("title")}
        </Heading>
      </Flex>

      {pending.length === 0 ? (
        <EmptyState variant="filtered" title={t("empty")} />
      ) : (
        <Flex direction="column" px={{ initial: "0", md: "6" }}>
          <Panel title={t("pending")}>
            <Flex direction="column" px="4" py="1">
              {pending.map((movement, index) => (
                <Fragment key={movement.id}>
                  {index > 0 && <Separator size="4" />}
                  <SettlementRow
                    movement={movement}
                    accountId={accountId}
                    currency={currency}
                    canWrite={canWrite}
                  />
                </Fragment>
              ))}
            </Flex>
          </Panel>
        </Flex>
      )}
    </>
  );
}
