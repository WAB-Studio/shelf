import { hasLocale } from "next-intl";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";

import { ReconcileAllScreen } from "@/components/accounts/reconcile-all-screen";
import { Page } from "@/components/ui";
import { listReconcileOverview } from "@/db/queries/account-reconciliations";
import { requireUser } from "@/db/session";
import { routing } from "@/i18n/routing";
import { todayInBogota } from "@/lib/dates";
import { reconcileAge } from "@/lib/reconcile-age";

export async function generateMetadata(
  props: PageProps<"/[locale]/settings/accounts/reconcile">,
): Promise<Metadata> {
  const { locale } = await props.params;
  if (!hasLocale(routing.locales, locale)) notFound();

  const t = await getTranslations({ locale, namespace: "accounts" });

  return { title: t("reconcileAllTitle") };
}

// «Cuadrar todo» (RF-261): every open account the caller can write, with today's derived figure, on one screen.
export default async function ReconcileAllPage(
  props: PageProps<"/[locale]/settings/accounts/reconcile">,
) {
  const { locale } = await props.params;
  if (!hasLocale(routing.locales, locale)) notFound();

  const today = todayInBogota();
  const [, overview] = await Promise.all([requireUser(), listReconcileOverview(today)]);

  return (
    <Page>
      <ReconcileAllScreen
        rows={overview.map((row) => {
          const { days, never } = reconcileAge(row, today);
          return {
            id: row.id,
            name: row.name,
            kind: row.kind,
            currency: row.settlementCurrency,
            derivedCents: row.derivedCents,
            institution: row.institution,
            lastFour: row.lastFour,
            holderName: row.holderName,
            ageDays: days,
            never,
            creditLimitCents: row.creditLimitCents,
            toBillCents: row.toBillCents,
          };
        })}
      />
    </Page>
  );
}
