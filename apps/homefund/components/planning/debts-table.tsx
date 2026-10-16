"use client";

import type { ReactNode } from "react";
import { useFormatter, useTranslations } from "next-intl";

import {
  Badge,
  Button,
  DataTable,
  Flex,
  Money,
  RowMenu,
  TablePagination,
  Text,
  type DataColumn,
} from "@/components/ui";
import type { DebtOverviewRow, DebtPocket } from "@/db/queries/debt-overview";
import type { PlanPosition } from "@/db/queries/installment-plans";
import type { CurrencyCode } from "@/lib/currency";
import { civilDateToDate } from "@/lib/dates";

// The em dash a cell with nothing to name reads as (SPEC-A3), not a word a
// translator would ever change.
const NO_VALUE = "—";

// The tracks of the Deudas artboard, in order.
const WIDTHS = {
  debt: "minmax(0, 1fr)",
  availableCredit: "140px",
  monthlyInterest: "124px",
  minimum: "130px",
  cutOff: "78px",
  dueDate: "78px",
  owed: "140px",
  menu: "36px",
} as const;

/**
 * One liability the screen draws. `terms` is null on a debt with no `debt_terms`
 * row: every derived figure it would carry then reads absent, and only its owed
 * magnitude and its invitation remain (RF-79). `planPosition` is independent of
 * terms — a plan sits on any liability (RF-81). `canWrite` is what the policies
 * would admit on this debt, which is what decides the actions it offers.
 */
export type DebtTableRow = {
  accountId: string;
  name: string;
  // The currency the debt bills in: every figure on its row is read in it, and
  // what it owes in another one rides in `otherOwed` (RF-121, RF-124).
  currency: CurrencyCode;
  owedCents: number;
  otherOwed: DebtPocket[];
  planPosition: PlanPosition | null;
  terms: DebtOverviewRow | null;
  canWrite: boolean;
};

/**
 * The dense Deudas of `private/design-desktop/SPEC-A3.md` (RF-83, RF-117): a debt
 * per row with its cupo, its monthly interest, its minimum, its two dates and
 * what it owes. Every figure arrives derived from the server and is only
 * formatted here — none is computed and none is stored (RNF-07). The caller owns
 * the page and the sort, and hands over the rows it wants drawn, ordered by the
 * due date this table inks as sorted.
 */
export function DebtsTable({
  rows,
  nextPaymentAccountId,
  page,
  pageSize,
  total,
  empty,
  onPrev,
  onNext,
  onPay,
  onNewPlan,
  onDetail,
  onEditTerms,
}: {
  rows: DebtTableRow[];
  // The fund's next payment, which the caller already reads off its totals
  // (RF-83). No row carries the badge when that debt is off the page.
  nextPaymentAccountId: string | null;
  // One-based, as the caption reads it.
  page: number;
  pageSize: number;
  // Every debt, not this page's.
  total: number;
  empty?: ReactNode;
  onPrev: () => void;
  onNext: () => void;
  onPay: (row: DebtTableRow) => void;
  onNewPlan: (row: DebtTableRow) => void;
  onDetail: (row: DebtTableRow) => void;
  onEditTerms: (row: DebtTableRow) => void;
}) {
  const t = useTranslations("debts");
  const tKey = useTranslations();
  const format = useFormatter();

  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);

  function shortDate(date: string): string {
    return format.dateTime(civilDateToDate(date), {
      day: "numeric",
      month: "short",
    });
  }

  function absent(): ReactNode {
    return (
      <Text size="2" color="gray">
        {NO_VALUE}
      </Text>
    );
  }

  const columns: DataColumn<DebtTableRow>[] = [
    {
      key: "debt",
      header: t("tableDebt"),
      width: WIDTHS.debt,
      cell: (row) => (
        <Flex direction="column" gap="1" minWidth="0">
          <Flex align="center" gap="2" minWidth="0">
            <Text size="2" weight="medium" truncate>
              {row.name}
            </Text>
            {row.accountId === nextPaymentAccountId && (
              <Badge color="jade" variant="soft" radius="full">
                {t("nextPaymentBadge")}
              </Badge>
            )}
          </Flex>
          <DebtMeta row={row} onEditTerms={() => onEditTerms(row)} />
        </Flex>
      ),
    },
    {
      key: "availableCredit",
      header: t("tableAvailableCredit"),
      width: WIDTHS.availableCredit,
      align: "end",
      numeric: true,
      // Null on a debt with no limit, which is not the same as a cupo of zero
      // (RF-117): it reads absent rather than spent.
      cell: (row) =>
        row.terms?.availableCreditCents == null ? (
          absent()
        ) : (
          <Money
            minor={row.terms.availableCreditCents}
            currency={row.currency}
            tone="income"
            signed={false}
          />
        ),
    },
    {
      key: "monthlyInterest",
      header: t("tableMonthlyInterest"),
      width: WIDTHS.monthlyInterest,
      align: "end",
      numeric: true,
      cell: (row) =>
        row.terms === null ? (
          absent()
        ) : (
          <Text color="gray">
            <Money
              minor={row.terms.monthlyInterestCents}
              currency={row.currency}
              signed={false}
            />
          </Text>
        ),
    },
    {
      key: "minimum",
      header: t("tableMinimum"),
      width: WIDTHS.minimum,
      align: "end",
      numeric: true,
      cell: (row) =>
        row.terms?.minimumPaymentCents == null ? (
          absent()
        ) : (
          <Text color="gray">
            <Money
              minor={row.terms.minimumPaymentCents}
              currency={row.currency}
              signed={false}
            />
          </Text>
        ),
    },
    {
      key: "cutOff",
      header: t("tableCutOff"),
      width: WIDTHS.cutOff,
      align: "end",
      numeric: true,
      cell: (row) =>
        row.terms?.nextCutOffDate == null ? (
          absent()
        ) : (
          <Text size="2" color="gray">
            {shortDate(row.terms.nextCutOffDate)}
          </Text>
        ),
    },
    {
      key: "dueDate",
      header: t("tableDueDate"),
      width: WIDTHS.dueDate,
      align: "end",
      numeric: true,
      // The rows arrive ordered by due date and no other order is on offer, so
      // the chevron reports the sort rather than opening one.
      sort: "asc",
      cell: (row) =>
        row.terms?.nextDueDate == null ? (
          absent()
        ) : (
          <Text size="2" color="gray">
            {shortDate(row.terms.nextDueDate)}
          </Text>
        ),
    },
    {
      key: "owed",
      header: t("tableBalance"),
      width: WIDTHS.owed,
      align: "end",
      numeric: true,
      // The magnitude a liability owes, which the server already derived from
      // its movements; the debt reads without a sign. The pocket it bills in
      // first, then what it owes in a currency it does not — one figure each,
      // never a sum of the two (RF-124).
      cell: (row) => (
        <Flex direction="column" align="end">
          <Money minor={row.owedCents} currency={row.currency} signed={false} />
          {row.otherOwed.map((pocket) => (
            <Text key={pocket.currency} size="1" color="gray">
              <Money
                minor={pocket.owedCents}
                currency={pocket.currency}
                signed={false}
                size="inherit"
              />
            </Text>
          ))}
        </Flex>
      ),
    },
    {
      key: "menu",
      header: "",
      width: WIDTHS.menu,
      align: "end",
      // Reading a debt is offered to everyone it is shown to; writing one only to
      // the caller the policies would admit, so a member is never handed an
      // action the database answers with a refusal (RF-58, RF-100).
      cell: (row) => (
        <RowMenu
          rowName={row.name}
          items={[
            ...(row.canWrite
              ? [
                  {
                    key: "pay",
                    label: t("rowPay"),
                    onSelect: () => onPay(row),
                  },
                  {
                    key: "plan",
                    label: t("rowNewPlan"),
                    onSelect: () => onNewPlan(row),
                  },
                ]
              : []),
            {
              key: "detail",
              label: t("rowDetail"),
              onSelect: () => onDetail(row),
            },
            ...(row.canWrite
              ? [
                  {
                    // The same door either way: a bare liability completes its
                    // terms, one that carries them edits them (RF-78).
                    key: "terms",
                    label:
                      row.terms === null ? t("completeTerms") : tKey("common.edit"),
                    onSelect: () => onEditTerms(row),
                  },
                ]
              : []),
          ]}
        />
      ),
    },
  ];

  return (
    <DataTable
      label={t("title")}
      columns={columns}
      rows={rows}
      rowKey={(row) => row.accountId}
      empty={empty}
      footer={
        pageCount > 1 && (
          <TablePagination
            caption={t("pageRange", { from, to, total })}
            onPrev={page > 1 ? onPrev : undefined}
            onNext={page < pageCount ? onNext : undefined}
            prevLabel={t("previousPage")}
            nextLabel={t("nextPage")}
          />
        )
      }
    />
  );
}

/**
 * The line under a debt's name. A plan states its position whether or not the
 * debt carries terms (RF-81); without a plan the terms' own kind speaks; with
 * neither, the debt owes without a rate and the row invites the terms it lacks
 * (RF-78, RF-79).
 */
function DebtMeta({
  row,
  onEditTerms,
}: {
  row: DebtTableRow;
  onEditTerms: () => void;
}) {
  const t = useTranslations("debts");
  const format = useFormatter();

  if (row.planPosition !== null) {
    return (
      <Text size="2" color="gray">
        {t("installmentPosition", {
          paid: row.planPosition.linesPaid,
          total: row.planPosition.linesTotal,
        })}
      </Text>
    );
  }

  if (row.terms === null) {
    // A caller who cannot write the debt is told what it lacks, not invited to
    // fill it in.
    return row.canWrite ? (
      <Flex>
        <Button type="button" variant="surface" size="1" onClick={onEditTerms}>
          {t("completeTerms")}
        </Button>
      </Flex>
    ) : (
      <Text size="2" color="gray">
        {t("noTermsMeta")}
      </Text>
    );
  }

  if (row.terms.debtKind === "installment") {
    return (
      <Text size="2" color="gray">
        {t("installmentMeta")}
      </Text>
    );
  }

  return (
    <Text size="2" color="gray">
      {t("revolvingMeta", {
        // The effective monthly step the server derived off the annual rate, only
        // read as a percentage here.
        pct: format.number(row.terms.monthlyRatePct, {
          style: "percent",
          minimumFractionDigits: 1,
          maximumFractionDigits: 1,
        }),
      })}
    </Text>
  );
}
