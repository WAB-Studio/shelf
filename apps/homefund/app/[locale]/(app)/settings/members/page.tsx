import { hasLocale } from "next-intl";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";

import { MembersScreen } from "@/components/members/members-screen";
import { Page } from "@/components/ui";
import { listMembers } from "@/db/queries/group-members";
import { getUserGroup, getUserGroupRole } from "@/db/queries/groups";
import { requireUser } from "@/db/session";
import { routing } from "@/i18n/routing";

export async function generateMetadata(
  props: PageProps<"/[locale]/settings/members">,
): Promise<Metadata> {
  const { locale } = await props.params;
  if (!hasLocale(routing.locales, locale)) notFound();

  const t = await getTranslations({ locale, namespace: "members" });

  return { title: t("title") };
}

export default async function MembersPage(
  props: PageProps<"/[locale]/settings/members">,
) {
  const { locale } = await props.params;
  if (!hasLocale(routing.locales, locale)) notFound();


  const { tab } = await props.searchParams;
  const archived = tab === "archived";

  const [user, group, role] = await Promise.all([
    requireUser(),
    getUserGroup(),
    getUserGroupRole(),
  ]);
  // Members live inside a group; a personal-only caller has none to list (RF-55).
  if (!group) notFound();

  const members = await listMembers(group.id, { archived });

  return (
    <Page>
      <MembersScreen
        members={members}
        currentUserId={user.id}
        archived={archived}
        isLeader={role === "leader"}
      />
    </Page>
  );
}
