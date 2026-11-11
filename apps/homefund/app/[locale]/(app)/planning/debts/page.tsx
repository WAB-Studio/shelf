import { hasLocale } from "next-intl";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";

import { DebtsScreen } from "@/components/planning/debts-screen";
import { MemberDebtsSection } from "@/components/planning/member-debts-section";
import { Page } from "@/components/ui";
import { getDebtsScreenData } from "@/db/queries/debts-screen";
import { getMemberDebts } from "@/db/queries/member-debts";
import { getUserGroup } from "@/db/queries/groups";
import { routing } from "@/i18n/routing";

export async function generateMetadata(
  props: PageProps<"/[locale]/planning/debts">,
): Promise<Metadata> {
  const { locale } = await props.params;
  if (!hasLocale(routing.locales, locale)) notFound();

  const t = await getTranslations({ locale, namespace: "debts" });

  return { title: t("title") };
}

export default async function DebtsPage(
  props: PageProps<"/[locale]/planning/debts">,
) {
  const { locale } = await props.params;
  if (!hasLocale(routing.locales, locale)) notFound();


  const [data, group, memberDebts] = await Promise.all([
    getDebtsScreenData(),
    getUserGroup(),
    getMemberDebts(),
  ]);

  return (
    <Page>
      <DebtsScreen data={data} hasGroup={group !== null}>
        {memberDebts && <MemberDebtsSection data={memberDebts} />}
      </DebtsScreen>
    </Page>
  );
}
