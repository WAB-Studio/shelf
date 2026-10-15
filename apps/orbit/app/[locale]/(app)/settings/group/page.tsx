import { hasLocale } from "next-intl";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";

import { GroupSettingsScreen } from "@/components/fund/group-settings-screen";
import { Page } from "@/components/ui";
import { getUserGroup, getUserGroupRole } from "@/db/queries/groups";
import { requireUser } from "@/db/session";
import { routing } from "@/i18n/routing";
import type { UpdateGroupInput } from "@/lib/validation/group";

export async function generateMetadata(
  props: PageProps<"/[locale]/settings/group">,
): Promise<Metadata> {
  const { locale } = await props.params;
  if (!hasLocale(routing.locales, locale)) notFound();

  const t = await getTranslations({ locale, namespace: "group" });

  return { title: t("title") };
}

export default async function GroupSettingsPage(
  props: PageProps<"/[locale]/settings/group">,
) {
  const { locale } = await props.params;
  if (!hasLocale(routing.locales, locale)) notFound();


  const [, group, role] = await Promise.all([
    requireUser(),
    getUserGroup(),
    getUserGroupRole(),
  ]);
  // There is nothing to configure without a group (RF-55); the shell layout
  // already refused this route, and this is what refuses it without the header.
  if (!group) notFound();

  return (
    <Page>
      <GroupSettingsScreen
        groupName={group.name}
        cashMode={group.cashMode}
        // The column is a bare ISO code (RF-121); this form is its only writer
        // and only ever writes one of the offered codes.
        currency={group.currency as UpdateGroupInput["currency"]}
        isLeader={role === "leader"}
      />
    </Page>
  );
}
