import { hasLocale } from "next-intl";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";

import { RecurringScreen } from "@/components/planning/recurring-screen";
import { Page } from "@/components/ui";
import { getUserGroup } from "@/db/queries/groups";
import {
  countUnreviewedGenerated,
  listRecurringRules,
} from "@/db/queries/recurring-rules";
import { getTransactionFormOptions } from "@/db/queries/transaction-form";
import { routing } from "@/i18n/routing";

export async function generateMetadata(
  props: PageProps<"/[locale]/planning/recurring">,
): Promise<Metadata> {
  const { locale } = await props.params;
  if (!hasLocale(routing.locales, locale)) notFound();

  const t = await getTranslations({ locale, namespace: "recurringRules" });

  return { title: t("title") };
}

export default async function RecurringPage(
  props: PageProps<"/[locale]/planning/recurring">,
) {
  const { locale } = await props.params;
  if (!hasLocale(routing.locales, locale)) notFound();


  const [rules, unreviewedCount, options, group] = await Promise.all([
    listRecurringRules(),
    countUnreviewedGenerated(),
    getTransactionFormOptions(),
    getUserGroup(),
  ]);

  return (
    <Page>
      <RecurringScreen
        rules={rules}
        unreviewedCount={unreviewedCount}
        options={options}
        hasGroup={group !== null}
      />
    </Page>
  );
}
