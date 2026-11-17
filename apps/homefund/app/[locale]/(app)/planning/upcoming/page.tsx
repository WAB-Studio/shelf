import { hasLocale } from "next-intl";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";

import { UpcomingScreen } from "@/components/planning/upcoming-screen";
import { Page } from "@/components/ui";
import { getUserGroup } from "@/db/queries/groups";
import { listPlannedPayments } from "@/db/queries/planned-payments";
import {
  countUnreviewedGenerated,
  listRecurringRules,
} from "@/db/queries/recurring-rules";
import { listRecurringCharges } from "@/db/queries/spending-patterns";
import { getTransactionFormOptions } from "@/db/queries/transaction-form";
import { routing } from "@/i18n/routing";

export async function generateMetadata(
  props: PageProps<"/[locale]/planning/upcoming">,
): Promise<Metadata> {
  const { locale } = await props.params;
  if (!hasLocale(routing.locales, locale)) notFound();

  const t = await getTranslations({ locale, namespace: "upcoming" });

  return { title: t("title") };
}

export default async function UpcomingPage(
  props: PageProps<"/[locale]/planning/upcoming">,
) {
  const { locale } = await props.params;
  if (!hasLocale(routing.locales, locale)) notFound();

  const [payments, rules, charges, unreviewedCount, options, group] = await Promise.all([
    listPlannedPayments({ status: "pending" }),
    listRecurringRules(),
    listRecurringCharges(),
    countUnreviewedGenerated(),
    getTransactionFormOptions(),
    getUserGroup(),
  ]);

  return (
    <Page>
      <UpcomingScreen
        payments={payments}
        rules={rules}
        charges={charges}
        unreviewedCount={unreviewedCount}
        options={options}
        hasGroup={group !== null}
      />
    </Page>
  );
}
