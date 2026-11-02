"use client";

import type { ReactNode } from "react";
import { Plus } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useState } from "react";

import {
  AccountStatementDialog,
  type StatementAccount,
} from "@/components/planning/account-statement-dialog";
import {
  Box,
  Button,
  Card,
  DataTable,
  EmptyState,
  Flex,
  Heading,
  Money,
  Text,
  type DataColumn,
} from "@/components/ui";
import type { AccountStatementRow } from "@/db/queries/account-statements";
import type { CurrencyCode } from "@/lib/currency";
import { civilDateToDate } from "@/lib/dates";

const STATEMENT_WIDTHS = {
  period: "minmax(0, 1fr)",
  cutOff: "110px",
  dueDate: "110px",
  balance: "140px",
  minimum: "130px",
  interest: "130px",
  fees: "130px",
  gap: "140px",
} as const;

/**
 * The closed periods, newest first (RF-129), each with what the statement
 * charged (RF-130) and the gap between its printed close and the account's
 * own movements. Every figure but the gap is the snapshot frozen at that
 * cut-off, read as stored and never recomputed here; the gap itself arrives
 * already derived from the server, one round trip earlier.
 */
export function StatementsSection({
  account,
  currency,
  statements,
  canWrite,
}: {
  account: StatementAccount;
  currency: CurrencyCode;
  statements: AccountStatementRow[];
  canWrite: boolean;
}): ReactNode {
  const t = useTranslations("installments");
  const format = useFormatter();
  const [recordOpen, setRecordOpen] = useState(false);

  function shortDate(date: string): string {
    return format.dateTime(civilDateToDate(date), {
      day: "numeric",
      month: "short",
    });
  }

  const columns: DataColumn<AccountStatementRow>[] = [
    {
      key: "period",
      header: t("statementPeriod"),
      width: STATEMENT_WIDTHS.period,
      numeric: true,
      // The day the period opened; the column beside it closes the period.
      cell: (statement) => (
        <Text size="2">{shortDate(statement.periodStart)}</Text>
      ),
    },
    {
      key: "cutOff",
      header: t("statementCutOff"),
      width: STATEMENT_WIDTHS.cutOff,
      numeric: true,
      cell: (statement) => (
        <Text size="2" color="gray">
          {shortDate(statement.cutOffDate)}
        </Text>
      ),
    },
    {
      key: "dueDate",
      header: t("statementDueDate"),
      width: STATEMENT_WIDTHS.dueDate,
      numeric: true,
      // An asset's statement demands no payment, so it prints no due date (RF-129).
      cell: (statement) =>
        statement.paymentDueDate === null ? null : (
          <Text size="2" color="gray">
            {shortDate(statement.paymentDueDate)}
          </Text>
        ),
    },
    {
      key: "balance",
      header: t("statementBalance"),
      width: STATEMENT_WIDTHS.balance,
      align: "end",
      numeric: true,
      cell: (statement) => (
        <Money
          minor={Math.abs(statement.closingBalanceCents)}
          currency={currency}
          signed={false}
        />
      ),
    },
    {
      key: "minimum",
      header: t("statementMinimum"),
      width: STATEMENT_WIDTHS.minimum,
      align: "end",
      numeric: true,
      cell: (statement) =>
        statement.minimumPaymentCents === null ? null : (
          <Text color="gray">
            <Money
              minor={statement.minimumPaymentCents}
              currency={currency}
              signed={false}
            />
          </Text>
        ),
    },
    {
      key: "interest",
      header: t("statementInterest"),
      width: STATEMENT_WIDTHS.interest,
      align: "end",
      numeric: true,
      // What the statement charged, or an empty cell where it recorded none: a zero
      // here would read as "the issuer charged no interest" (RF-130).
      cell: (statement) =>
        statement.interestChargedCents === null ? null : (
          <Text color="gray">
            <Money
              minor={statement.interestChargedCents}
              currency={currency}
              signed={false}
            />
          </Text>
        ),
    },
    {
      key: "fees",
      header: t("statementFees"),
      width: STATEMENT_WIDTHS.fees,
      align: "end",
      numeric: true,
      // Same rule as interest: a zero would claim the bank charged nothing, while
      // an empty cell says the statement never printed the figure (RF-130).
      cell: (statement) =>
        statement.feesChargedCents === null ? null : (
          <Text color="gray">
            <Money
              minor={statement.feesChargedCents}
              currency={currency}
              signed={false}
            />
          </Text>
        ),
    },
    {
      key: "gap",
      header: t("statementGap"),
      width: STATEMENT_WIDTHS.gap,
      align: "end",
      numeric: true,
      // The distance between the printed close and the movements, computed on
      // the server (RF-129) — no subtraction happens on this screen.
      cell: (statement) =>
        statement.reconciliationGapCents === 0 ? (
          <Text color="gray">{t("statementGapMatches")}</Text>
        ) : (
          <Money
            minor={statement.reconciliationGapCents}
            currency={currency}
            signed
          />
        ),
    },
  ];

  // The same columns the table draws after the dates, one line each on the
  // phone; a column with nothing to show drops its line.
  function phoneFigures(statement: AccountStatementRow): [string, ReactNode][] {
    return columns
      .filter((column) => column.align === "end")
      .map((column): [string, ReactNode] => [column.header, column.cell(statement)])
      .filter(([, cell]) => cell !== null);
  }

  const emptyState = (
    <EmptyState
      variant="filtered"
      title={t("statementsEmpty")}
      description={t("statementsEmptyRecord")}
    />
  );

  const recordButton = canWrite && (
    <Button
      type="button"
      variant="surface"
      color="gray"
      onClick={() => setRecordOpen(true)}
    >
      <Plus size={15} />
      {t("statementRecord")}
    </Button>
  );

  return (
    <>
      <Flex
        align="center"
        justify="between"
        gap="3"
        px={{ initial: "0", md: "6" }}
      >
        <Heading as="h2" size="3">
          {t("statementsTitle")}
        </Heading>
        {recordButton}
      </Flex>

      <Box display={{ initial: "none", lg: "block" }}>
        <DataTable
          label={t("statementsTitle")}
          columns={columns}
          rows={statements}
          rowKey={(statement) => statement.id}
          empty={emptyState}
        />
      </Box>

      {/* The phone reads each statement as a card: eight tracks do not fit. */}
      <Box display={{ initial: "block", lg: "none" }}>
        {statements.length === 0 ? (
          emptyState
        ) : (
          <Flex direction="column" gap="3">
            {statements.map((statement) => (
              <Card key={statement.id}>
                <Flex direction="column" gap="2">
                  <Flex justify="between" align="baseline" gap="3" wrap="wrap">
                    <Text size="3" weight="medium">
                      {shortDate(statement.periodStart)} – {shortDate(statement.cutOffDate)}
                    </Text>
                    {statement.paymentDueDate !== null && (
                      <Text size="2" color="gray">
                        {t("statementDueDate")} {shortDate(statement.paymentDueDate)}
                      </Text>
                    )}
                  </Flex>
                  {phoneFigures(statement).map(([label, cell]) => (
                    <Flex key={label} justify="between" align="baseline" gap="3">
                      <Text size="2" color="gray">
                        {label}
                      </Text>
                      <Text size="2">{cell}</Text>
                    </Flex>
                  ))}
                </Flex>
              </Card>
            ))}
          </Flex>
        )}
      </Box>

      {recordOpen && (
        <AccountStatementDialog
          open
          onOpenChange={(open) => {
            if (!open) setRecordOpen(false);
          }}
          account={account}
          currency={currency}
        />
      )}
    </>
  );
}
