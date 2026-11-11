import { hasLocale } from "next-intl";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";

import { SubscriptionsScreen } from "@/components/planning/subscriptions-screen";
import { Page } from "@/components/ui";
import { getUserGroup } from "@/db/queries/groups";
import { listRecurringCharges } from "@/db/queries/spending-patterns";
import { routing } from "@/i18n/routing";

export async function generateMetadata(
  props: PageProps<"/[locale]/planning/subscriptions">,
): Promise<Metadata> {
  const { locale } = await props.params;
  if (!hasLocale(routing.locales, locale)) notFound();

  const t = await getTranslations({ locale, namespace: "subscriptions" });

  return { title: t("title") };
}

export default async function SubscriptionsPage(
  props: PageProps<"/[locale]/planning/subscriptions">,
) {
  const { locale } = await props.params;
  if (!hasLocale(routing.locales, locale)) notFound();

  const [charges, group] = await Promise.all([listRecurringCharges(), getUserGroup()]);

  return (
    <Page>
      <SubscriptionsScreen charges={charges} hasGroup={group !== null} />
    </Page>
  );
}
