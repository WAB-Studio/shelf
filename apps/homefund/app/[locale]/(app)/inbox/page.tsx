import { hasLocale } from "next-intl";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";

import { InboxScreen } from "@/components/ingest/inbox-screen";
import { Page } from "@/components/ui";
import {
  listPendingDeliveries,
  listSilencedShapes,
} from "@/db/queries/ingest-review";
import { getTransactionFormOptions } from "@/db/queries/transaction-form";
import { requireUser } from "@/db/session";
import { routing } from "@/i18n/routing";

export async function generateMetadata(
  props: PageProps<"/[locale]/inbox">,
): Promise<Metadata> {
  const { locale } = await props.params;
  if (!hasLocale(routing.locales, locale)) notFound();

  const t = await getTranslations({ locale, namespace: "ingest" });

  return { title: t("title") };
}

export default async function InboxPage(
  props: PageProps<"/[locale]/inbox">,
) {
  const { locale } = await props.params;
  if (!hasLocale(routing.locales, locale)) notFound();


  const [, deliveries, shapes, options] = await Promise.all([
    requireUser(),
    listPendingDeliveries(),
    listSilencedShapes(),
    getTransactionFormOptions(),
  ]);

  return (
    <Page>
      <InboxScreen
        deliveries={deliveries}
        shapes={shapes}
        options={options}
      />
    </Page>
  );
}
