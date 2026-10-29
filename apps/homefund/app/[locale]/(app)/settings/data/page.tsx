import { hasLocale } from "next-intl";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";

import { DataScreen } from "@/components/data/data-screen";
import { Page } from "@/components/ui";
import { requireUser } from "@/db/session";
import { SHEET_ENTITIES } from "@/lib/spreadsheet/schema";
import { routing } from "@/i18n/routing";

export async function generateMetadata(
  props: PageProps<"/[locale]/settings/data">,
): Promise<Metadata> {
  const { locale } = await props.params;
  if (!hasLocale(routing.locales, locale)) notFound();

  const t = await getTranslations({ locale, namespace: "data" });

  return { title: t("screen.title") };
}

export default async function DataPage(
  props: PageProps<"/[locale]/settings/data">,
) {
  const { locale } = await props.params;
  if (!hasLocale(routing.locales, locale)) notFound();


  await requireUser();

  return (
    <Page>
      <DataScreen entities={SHEET_ENTITIES} />
    </Page>
  );
}
