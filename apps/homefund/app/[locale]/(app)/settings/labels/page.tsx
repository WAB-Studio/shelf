import { hasLocale } from "next-intl";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";

import { LabelsScreen } from "@/components/labels/labels-screen";
import { Page } from "@/components/ui";
import { getUserGroup, getUserGroupRole } from "@/db/queries/groups";
import { listManagedLabels, listUsedLabelColors } from "@/db/queries/labels";
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


  // The screen presents both scopes (RF-70), so the caller's group is resolved
  // first: it names the second scope the reads below key off. The group reads
  // collapse to resolved empties when the caller runs personal-only.
  const [user, group] = await Promise.all([requireUser(), getUserGroup()]);

  const personalScope = { ownerUserId: user.id } as const;
  const empty = Promise.resolve([]);

  const [personal, personalColors, role, groupLabels, groupColors] =
    await Promise.all([
      listManagedLabels(personalScope),
      listUsedLabelColors(personalScope),
      getUserGroupRole(),
      group ? listManagedLabels({ groupId: group.id }) : empty,
      group ? listUsedLabelColors({ groupId: group.id }) : empty,
    ]);

  return (
    <Page>
      <LabelsScreen
        personal={personal}
        group={groupLabels}
        groupName={group?.name ?? null}
        canManageGroup={role === "leader"}
        usedColors={{ personal: personalColors, group: groupColors }}
      />
    </Page>
  );
}
