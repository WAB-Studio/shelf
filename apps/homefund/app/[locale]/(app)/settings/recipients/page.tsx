import { hasLocale } from "next-intl";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";

import { RecipientsScreen } from "@/components/recipients/recipients-screen";
import { Page } from "@/components/ui";
import { listRecipients } from "@/db/queries/recipients";
import { getTransactionFormOptions } from "@/db/queries/transaction-form";
import { requireUser } from "@/db/session";
import { routing } from "@/i18n/routing";

export async function generateMetadata(
  props: PageProps<"/[locale]/settings/recipients">,
): Promise<Metadata> {
  const { locale } = await props.params;
  if (!hasLocale(routing.locales, locale)) notFound();

  const t = await getTranslations({ locale, namespace: "recipients" });

  return { title: t("title") };
}

export default async function RecipientsPage(
  props: PageProps<"/[locale]/settings/recipients">,
) {
  const { locale } = await props.params;
  if (!hasLocale(routing.locales, locale)) notFound();

  const [, recipients, options] = await Promise.all([
    requireUser(),
    listRecipients(),
    getTransactionFormOptions(),
  ]);

  return (
    <Page>
      <RecipientsScreen recipients={recipients} options={options} />
    </Page>
  );
}
