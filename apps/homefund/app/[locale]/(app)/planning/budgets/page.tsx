import { hasLocale } from "next-intl";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { z } from "zod";

import { BudgetsScreen } from "@/components/planning/budgets-screen";
import { Page } from "@/components/ui";
import { listBudgetsWithStatus } from "@/db/queries/budgets";
import { getUserGroup } from "@/db/queries/groups";
import { getTransactionFormOptions } from "@/db/queries/transaction-form";
import { budgetAnchor } from "@/lib/dates";
import { monthParamSchema } from "@/lib/validation/month";
import { routing } from "@/i18n/routing";

const searchParamsSchema = z.object({ month: monthParamSchema });

export async function generateMetadata(
  props: PageProps<"/[locale]/planning/budgets">,
): Promise<Metadata> {
  const { locale } = await props.params;
  if (!hasLocale(routing.locales, locale)) notFound();

  const t = await getTranslations({ locale, namespace: "budgets" });

  return { title: t("title") };
}

export default async function BudgetsPage(
  props: PageProps<"/[locale]/planning/budgets">,
) {
  const { locale } = await props.params;
  if (!hasLocale(routing.locales, locale)) notFound();

  const searchParams = await props.searchParams;
  const { month } = searchParamsSchema.parse(searchParams);
  // The archived tab lists exactly the budgets the active one leaves out (RF-120).
  const archived = searchParams.tab === "archived";
  // The query slides each period's range around this anchor, never a stored
  // spent column (RF-160); the current month anchors on today, as /planning does.
  const anchor = budgetAnchor(month);

  const [budgets, options, group] = await Promise.all([
    listBudgetsWithStatus(anchor, { archived }),
    getTransactionFormOptions(),
    getUserGroup(),
  ]);

  return (
    <Page>
      <BudgetsScreen
        budgets={budgets}
        options={options}
        scopeCurrency={options.scopeCurrency}
        hasGroup={group !== null}
        month={month}
        archived={archived}
      />
    </Page>
  );
}
