import { hasLocale } from "next-intl";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";

import { GoalsScreen } from "@/components/planning/goals-screen";
import { Page } from "@/components/ui";
import { getUserGroup } from "@/db/queries/groups";
import { listGoalsWithProgress } from "@/db/queries/savings-goals";
import { getTransactionFormOptions } from "@/db/queries/transaction-form";
import { routing } from "@/i18n/routing";

export async function generateMetadata(
  props: PageProps<"/[locale]/planning/goals">,
): Promise<Metadata> {
  const { locale } = await props.params;
  if (!hasLocale(routing.locales, locale)) notFound();

  const t = await getTranslations({ locale, namespace: "goals" });

  return { title: t("title") };
}

export default async function GoalsPage(
  props: PageProps<"/[locale]/planning/goals">,
) {
  const { locale } = await props.params;
  if (!hasLocale(routing.locales, locale)) notFound();


  // The archived tab lists exactly the goals the active one leaves out (RF-120).
  const { tab } = await props.searchParams;
  const archived = tab === "archived";

  const [goals, options, group] = await Promise.all([
    listGoalsWithProgress({ archived }),
    getTransactionFormOptions(),
    getUserGroup(),
  ]);

  return (
    <Page gutter="flush-lg">
      <GoalsScreen
        goals={goals}
        options={options}
        scopeCurrency={options.scopeCurrency}
        hasGroup={group !== null}
        archived={archived}
      />
    </Page>
  );
}
