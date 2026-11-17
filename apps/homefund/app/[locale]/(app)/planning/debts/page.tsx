import { hasLocale } from "next-intl";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";

import { CardDeferrals } from "@/components/planning/card-deferrals";
import { DebtsScreen } from "@/components/planning/debts-screen";
import { MemberDebtsSection } from "@/components/planning/member-debts-section";
import { Page } from "@/components/ui";
import { listAllCardDeferrals } from "@/db/queries/card-deferrals";
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

  // A link from Inicio or Cuentas names the class of the debt to open the form on (RF-286).
  const { new: requested } = await props.searchParams;
  const newSubtype = requested === "card" || requested === "loan" ? requested : null;

  const [data, group, memberDebts, cardDeferrals] = await Promise.all([
    getDebtsScreenData(),
    getUserGroup(),
    getMemberDebts(),
    listAllCardDeferrals(),
  ]);
  // The cards the screen lists, by id: a deferral of one it does not list is not shown.
  const cardNames = Object.fromEntries([...data.withTerms, ...data.withoutTerms].map((debt) => [debt.accountId, debt.name]));
  const listed = cardDeferrals.filter((deferral) => deferral.accountId in cardNames);

  return (
    <Page>
      <DebtsScreen data={data} hasGroup={group !== null} newSubtype={newSubtype}>
        {listed.length > 0 && <CardDeferrals rows={listed} cardNames={cardNames} />}
        {memberDebts && <MemberDebtsSection data={memberDebts} />}
      </DebtsScreen>
    </Page>
  );
}
