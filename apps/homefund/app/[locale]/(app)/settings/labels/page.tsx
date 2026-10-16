import { hasLocale } from "next-intl";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";

import { LabelsScreen } from "@/components/labels/labels-screen";
import { Page } from "@/components/ui";
import { getLabelsScreenData } from "@/db/queries/labels";
import { requireUser } from "@/db/session";
import { routing } from "@/i18n/routing";

export async function generateMetadata(
  props: PageProps<"/[locale]/settings/labels">,
): Promise<Metadata> {
  const { locale } = await props.params;
  if (!hasLocale(routing.locales, locale)) notFound();

  const t = await getTranslations({ locale, namespace: "labels" });

  return { title: t("title") };
}

export default async function LabelsPage(
  props: PageProps<"/[locale]/settings/labels">,
) {
  const { locale } = await props.params;
  if (!hasLocale(routing.locales, locale)) notFound();


  const [, data] = await Promise.all([requireUser(), getLabelsScreenData()]);

  return (
    <Page>
      <LabelsScreen
        personal={data.personal}
        group={data.group}
        groupName={data.groupName}
        canManageGroup={data.isLeader}
        usedColors={data.usedColors}
      />
    </Page>
  );
}
