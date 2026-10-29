import { hasLocale } from "next-intl";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";

import { SettingsScreen } from "@/components/fund/settings-screen";
import { Page } from "@/components/ui";
import { getUserGroup } from "@/db/queries/groups";
import { requireUser } from "@/db/session";
import { routing } from "@/i18n/routing";

export async function generateMetadata(
  props: PageProps<"/[locale]/settings">,
): Promise<Metadata> {
  const { locale } = await props.params;
  if (!hasLocale(routing.locales, locale)) notFound();

  const t = await getTranslations({ locale, namespace: "nav" });

  return { title: t("settings") };
}

export default async function SettingsPage(
  props: PageProps<"/[locale]/settings">,
) {
  const { locale } = await props.params;
  if (!hasLocale(routing.locales, locale)) notFound();


  // Miembros only exists inside a fund (RF-55), so the list is built from the
  // caller's group; the auth guard rides beside that read, never ahead of it.
  const [, group] = await Promise.all([requireUser(), getUserGroup()]);

  return (
    <Page gutter="flush-md">
      <SettingsScreen hasGroup={group !== null} />
    </Page>
  );
}
