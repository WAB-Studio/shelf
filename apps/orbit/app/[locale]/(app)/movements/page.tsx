import { hasLocale } from "next-intl";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";

import { MovementsScreen } from "@/components/transactions/movements-screen";
import { Page } from "@/components/ui";
import { getRecurringRuleName } from "@/db/queries/recurring-rules";
import { getTransactionFormOptions } from "@/db/queries/transaction-form";
import { listTransactions } from "@/db/queries/transactions";
import type { TransactionListFilters } from "@/db/queries/transactions";
import { movementFiltersSchema } from "@/lib/validation/transaction";
import { routing } from "@/i18n/routing";

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

  // The type chip maps to the generated `kind`; "all" drops the predicate so
  // the list carries every kind (RF-23). A transfer is a kind of its own, so
  // the expense and income chips can never surface it (RF-19).
  const filters: TransactionListFilters = {
    kind: parsed.type === "all" ? undefined : parsed.type,
    from: parsed.from,
    to: parsed.to,
    memberUserId: parsed.member,
    accountId: parsed.account,
    categoryId: parsed.category,
    labelId: parsed.label,
    unreviewed: parsed.unreviewed,
    recurringRuleId: parsed.rule,
  };

  const [rows, options, ruleName] = await Promise.all([
    listTransactions(filters),
    getTransactionFormOptions(),
    parsed.rule ? getRecurringRuleName({ id: parsed.rule }) : Promise.resolve(null),
  ]);

  return (
    <Page gutter="flush-lg">
      <MovementsScreen
        rows={rows}
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
