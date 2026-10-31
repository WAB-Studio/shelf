import { hasLocale } from "next-intl";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";

import { MovementsScreen } from "@/components/transactions/movements-screen";
import { Page } from "@/components/ui";
import { getRecurringRuleName } from "@/db/queries/recurring-rules";
import { getTransactionFormOptions } from "@/db/queries/transaction-form";
import { getTransactionTotals, listTransactions } from "@/db/queries/transactions";
import type { TransactionListFilters } from "@/db/queries/transactions";
import { movementFiltersSchema, movementTypeFilter } from "@/lib/validation/transaction";
import { routing } from "@/i18n/routing";
import { addCivilDays, currentMonthRange } from "@/lib/dates";

// Server-side ceiling: the screen pages the rows on the client but counts and
// nets every row it receives, so an unbounded read grows with the ledger's whole
// history. Far above a household's month; the count and net come from SQL, so
// they stay exact past it.
const MOVEMENTS_LIMIT = 2000;

export async function generateMetadata(
  props: PageProps<"/[locale]/movements">,
): Promise<Metadata> {
  const { locale } = await props.params;
  if (!hasLocale(routing.locales, locale)) notFound();

  const t = await getTranslations({ locale, namespace: "transactions" });

  return { title: t("listTitle") };
}

export default async function MovementsPage(
  props: PageProps<"/[locale]/movements">,
) {
  const { locale } = await props.params;
  if (!hasLocale(routing.locales, locale)) notFound();


  const parsed = movementFiltersSchema.parse(await props.searchParams);

  // The type chip maps to the generated `kind`, or to the adjustments flag; "all"
  // drops the predicate so the list carries every kind (RF-23, RF-138). A transfer
  // is a kind of its own, so the expense and income chips can never surface it (RF-19).
  const filters: TransactionListFilters = {
    ...movementTypeFilter(parsed.type),
    from: parsed.from,
    to: parsed.to,
    memberUserId: parsed.member,
    accountId: parsed.account,
    categoryId: parsed.category,
    labelId: parsed.label,
    unreviewed: parsed.unreviewed,
    recurringRuleId: parsed.rule,
  };

  // The headline net follows the screen's period: the dates the filters name, or
  // this month when they name none. The count stays over the whole list.
  const ranged = Boolean(parsed.from || parsed.to);
  const month = currentMonthRange();

  const [rows, totals, monthTotals, options, ruleName] = await Promise.all([
    listTransactions(filters, { limit: MOVEMENTS_LIMIT }),
    getTransactionTotals(filters),
    ranged
      ? Promise.resolve(null)
      : getTransactionTotals({
          ...filters,
          from: month.start,
          to: addCivilDays(month.endExclusive, -1),
        }),
    getTransactionFormOptions(),
    parsed.rule ? getRecurringRuleName({ id: parsed.rule }) : Promise.resolve(null),
  ]);

  return (
    <Page gutter="flush-lg">
      <MovementsScreen
        rows={rows}
        totals={totals}
        netNets={(monthTotals ?? totals).nets}
        netMonthStart={ranged ? null : month.start}
        options={options}
        ruleName={ruleName}
        filters={{
          type: parsed.type,
          from: parsed.from ?? null,
          to: parsed.to ?? null,
          member: parsed.member ?? null,
          account: parsed.account ?? null,
          category: parsed.category ?? null,
          label: parsed.label ?? null,
          unreviewed: parsed.unreviewed,
          rule: parsed.rule ?? null,
        }}
      />
    </Page>
  );
}
