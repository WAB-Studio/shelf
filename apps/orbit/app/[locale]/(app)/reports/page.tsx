import { hasLocale } from "next-intl";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";

import { ReportsScreen } from "@/components/reports/reports-screen";
import { Page } from "@/components/ui";
import { getReportsData } from "@/db/queries/reports/reports-screen";
import { routing } from "@/i18n/routing";

export async function generateMetadata(
  props: PageProps<"/[locale]/reports">,
): Promise<Metadata> {
  const { locale } = await props.params;
  if (!hasLocale(routing.locales, locale)) notFound();

  const t = await getTranslations({ locale, namespace: "reports" });

  return { title: t("title") };
}

export default async function ReportsPage(
  props: PageProps<"/[locale]/reports">,
) {
  const { locale } = await props.params;
  if (!hasLocale(routing.locales, locale)) notFound();


  const [data] = await Promise.all([getReportsData()]);

  return (
    <Page>
      <ReportsScreen data={data} />
    </Page>
  );
}
