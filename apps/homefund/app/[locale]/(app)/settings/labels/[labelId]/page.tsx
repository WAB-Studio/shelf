import { hasLocale } from "next-intl";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { z } from "zod";

import { PersonScreen } from "@/components/labels/person-screen";
import { Page } from "@/components/ui";
import { getLabelsScreenData } from "@/db/queries/labels";
import { getPersonLedger } from "@/db/queries/owed-to-me";
import { requireUser } from "@/db/session";
import { routing } from "@/i18n/routing";

export async function generateMetadata(
  props: PageProps<"/[locale]/settings/labels/[labelId]">,
): Promise<Metadata> {
  const { locale } = await props.params;
  if (!hasLocale(routing.locales, locale)) notFound();

  const t = await getTranslations({ locale, namespace: "labels" });

  return { title: t("title") };
}

export default async function PersonPage(
  props: PageProps<"/[locale]/settings/labels/[labelId]">,
) {
  const { locale, labelId } = await props.params;
  if (!hasLocale(routing.locales, locale)) notFound();
  if (!z.uuid().safeParse(labelId).success) notFound();

  const [, data, ledgers] = await Promise.all([requireUser(), getLabelsScreenData(), getPersonLedger(labelId)]);
  const person = [...data.personal, ...data.group].find((label) => label.id === labelId && label.kind === "person");
  if (!person) notFound();

  return (
    <Page>
      <PersonScreen name={person.name} charged={person.chargeDefault} ledgers={ledgers} />
    </Page>
  );
}
