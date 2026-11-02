"use client";

import { Fragment, type ReactNode } from "react";
import { useFormatter, useLocale, useTranslations } from "next-intl";

import {
  Badge,
  Button,
  DataTable,
  Figure,
  Flex,
  Money,
  PersonalMark,
  RowMenu,
  TablePagination,
  Text,
  type DataColumn,
} from "@/components/ui";
import type { DebtOverviewRow, DebtPocket } from "@/db/queries/debt-overview";
import type { PlanPosition } from "@/db/queries/installment-plans";
import type { CurrencyCode } from "@/lib/currency";
import { civilDateToDate } from "@/lib/dates";
import type { Locale } from "@/lib/locales";
import { formatMoney } from "@/lib/money";

// The em dash a cell with nothing to name reads as (SPEC-A3), not a word a
// translator would ever change.
const NO_VALUE = "—";

// The tracks of the Deudas artboard, in order. The balance track holds
// «A favor $ 150.000» in bold with room to spare; the figure columns before it
// give up what it and the gaps take, so the debt's own track keeps its width.
const WIDTHS = {
  debt: "minmax(0, 1fr)",
  availableCredit: "112px",
  monthlyInterest: "92px",
  minimum: "96px",
  cutOff: "64px",
  dueDate: "68px",
  owed: "196px",
  menu: "36px",
} as const;

// Every figure is end-aligned against the next column's start, so the gap is
// what keeps a long one clear of the date before it.
const COLUMN_GAP = "8px";

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
  personal: boolean;
  // The currency the debt bills in: every figure on its row is read in it, and
  // what it owes in another one rides in `otherOwed` (RF-121, RF-124).
  currency: CurrencyCode;
  owedCents: number;
  creditCents: number;
  otherOwed: DebtPocket[];
  planPosition: PlanPosition | null;
  terms: DebtOverviewRow | null;
  canWrite: boolean;
};

const AMOUNT_SLOT = "\u0000";

// The words of a message around its amount, which `Money` then draws inside its
// own span: the placeholder only marks where the figure goes.
function wordsAround(message: string): { before: string; after: string } {
  const [before, after = ""] = message.split(AMOUNT_SLOT);
  return { before, after };
}

// The dot closes the figure before it, so a wrapped line ends on «·» and the next
// starts on a word, never inside a figure.
function closed(words: { before: string; after: string }, more: boolean) {
  return more ? { before: words.before, after: `${words.after} ·` } : words;
}

/**
 * Whether a debt in credit also owes in another currency (Q9 a): the one case
 * its balance reads as a line of two figures instead of one.
 */
export function owesBesideCredit(
  creditCents: number,
  otherOwed: DebtPocket[],
): boolean {
  return creditCents > 0 && otherOwed.some((pocket) => pocket.owedCents > 0);
}

/**
 * «A favor $ 8.000 · Debes US$ 25 (≈ $ 105.000 por facturar)» (RF-80, RF-124):
 * the credit in the accent, what the other pockets owe and what is still to bill
 * in the normal ink. The figures are never added to one another. The estimate
 * is drawn only while the pocket has one, in the currency the debt bills in.
 */
export function CreditAndOwedLine({
  creditCents,
  currency,
  otherOwed,
  align = "right",
  size = "2",
  owedBold = false,
  inherit = false,
}: {
  creditCents: number;
  currency: CurrencyCode;
  otherOwed: DebtPocket[];
  // The row hangs the line off its right edge; the abono dialog reads it from the left.
  align?: "left" | "right";
  size?: "1" | "2" | "3";
  // What the other pockets owe in bold, as the abono dialog draws it.
  owedBold?: boolean;
  // Takes the type of the tile it sits in, as `PocketFigure` does.
  inherit?: boolean;
}) {
  const t = useTranslations("debts");
  const owed = otherOwed.filter((pocket) => pocket.owedCents > 0);

  return (
    <Figure as="div" size={inherit ? undefined : size} align={align}>
      <Money
        minor={creditCents}
        currency={currency}
        tone="credit"
        size="inherit"
        words={closed(wordsAround(t("inFavour", { amount: AMOUNT_SLOT })), owed.length > 0)}
      />
      {owed.map((pocket, index) => {
        // `Money` writes the estimate mark itself, so the message's own is
        // dropped from the words.
        const toBill = wordsAround(t("toBill", { amount: AMOUNT_SLOT }));
        const more = index < owed.length - 1;
        return (
          <Fragment key={pocket.currency}>
            {" "}
            <Text weight={owedBold ? "bold" : undefined}>
              <Money
                minor={pocket.owedCents}
                currency={pocket.currency}
                size="inherit"
                signed={false}
                words={closed(
                  wordsAround(t("owesForeign", { amount: AMOUNT_SLOT })),
                  more && pocket.toBillCents === null,
                )}
              />
            </Text>
            {pocket.toBillCents !== null && (
              <>
                {" "}
                <Text color="gray">
                  <Money
                    minor={pocket.toBillCents}
                    currency={currency}
                    size="inherit"
                    signed={false}
                    estimate
                    words={closed({ before: toBill.before.replace("\u2248 ", ""), after: toBill.after }, more)}
                  />
                </Text>
              </>
            )}
          </Fragment>
        );
      })}
    </Figure>
  );
}

/**
 * A pocket read by its own sign (RF-80, RF-124): «A favor …» in the accent ink
 * while it holds credit, the plain amount otherwise. `bold` is the debt's own
 * figure; the pockets under it stay small and grey. `inherit` takes the type and
 * the ink of a tile or a header that already sets its own.
 */
export function PocketFigure({
  owedCents,
  creditCents,
  currency,
  bold = false,
  inherit = false,
  named = false,
}: {
  owedCents: number;
  creditCents: number;
  currency: CurrencyCode;
  bold?: boolean;
  inherit?: boolean;
  // A pocket that owes reads «Debes US$ 20,00» instead of the bare amount.
  named?: boolean;
}) {
  const t = useTranslations("debts");
  const locale = useLocale() as Locale;
  const size = bold || inherit ? undefined : "1";

  // «A favor $ 8.000», or with `named` «Debes US$ 20,00»: the amount in words.
  const worded = creditCents > 0 ? "inFavour" : named && owedCents > 0 ? "owesForeign" : null;
  if (worded !== null) {
    return (
      <Figure size={size} weight={bold ? "bold" : undefined}>
        <Money
          minor={worded === "inFavour" ? creditCents : owedCents}
          currency={currency}
          tone={worded === "inFavour" ? "credit" : undefined}
          size="inherit"
          signed={false}
          words={wordsAround(t(worded, { amount: AMOUNT_SLOT }))}
        />
      </Figure>
    );
  }
  return (
    <Figure
      size={size}
      weight={bold ? "bold" : undefined}
      color={bold || inherit ? undefined : "gray"}
    >
      {formatMoney(owedCents, currency, locale)}
    </Figure>
  );
}

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

  const tAccounts = useTranslations("accounts");

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
            {row.personal && <PersonalMark label={tAccounts("ownerPersonal")} />}
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
        row.terms === null || row.owedCents === 0 ? (
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
        row.terms?.minimumPaymentCents == null || row.owedCents === 0 ? (
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
      cell: (row) =>
        owesBesideCredit(row.creditCents, row.otherOwed) ? (
          <Flex direction="column" align="end">
            <CreditAndOwedLine
              creditCents={row.creditCents}
              currency={row.currency}
              otherOwed={row.otherOwed}
            />
            {row.otherOwed
              .filter((pocket) => pocket.owedCents === 0)
              .map((pocket) => (
                <PocketFigure
                  key={pocket.currency}
                  owedCents={pocket.owedCents}
                  creditCents={pocket.creditCents}
                  currency={pocket.currency}
                />
              ))}
          </Flex>
        ) : (
        <Flex direction="column" align="end">
          {row.creditCents > 0 ? (
            <PocketFigure
              owedCents={0}
              creditCents={row.creditCents}
              currency={row.currency}
              bold
            />
          ) : (
            <Money
              minor={row.owedCents}
              currency={row.currency}
              signed={false}
            />
          )}
          {row.otherOwed.map((pocket) => (
            <PocketFigure
              key={pocket.currency}
              owedCents={pocket.owedCents}
              creditCents={pocket.creditCents}
              currency={pocket.currency}
            />
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
      columnGap={COLUMN_GAP}
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
