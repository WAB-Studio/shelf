import { hasLocale } from "next-intl";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";

import { PaymentsScreen } from "@/components/planning/payments-screen";
import { Page } from "@/components/ui";
import { getUserGroup } from "@/db/queries/groups";
import { listPlannedPayments } from "@/db/queries/planned-payments";
import { getTransactionFormOptions } from "@/db/queries/transaction-form";
import { routing } from "@/i18n/routing";

export async function generateMetadata(
  props: PageProps<"/[locale]/planning/payments">,
): Promise<Metadata> {
  const { locale } = await props.params;
  if (!hasLocale(routing.locales, locale)) notFound();

  const t = await getTranslations({ locale, namespace: "plannedPayments" });

  return { title: t("title") };
}

export default async function PaymentsPage(
  props: PageProps<"/[locale]/planning/payments">,
) {
  const { locale } = await props.params;
  if (!hasLocale(routing.locales, locale)) notFound();


  const [payments, options, group] = await Promise.all([
    listPlannedPayments({ status: "pending" }),
    getTransactionFormOptions(),
    getUserGroup(),
  ]);

  return (
    <Page>
      <PaymentsScreen
        payments={payments}
        options={options}
        hasGroup={group !== null}
      />
    </Page>
  );
}
