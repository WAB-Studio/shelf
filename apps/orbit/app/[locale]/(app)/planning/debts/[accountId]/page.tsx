import { hasLocale } from "next-intl";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { cache } from "react";

import { DebtDetailScreen } from "@/components/planning/debt-detail-screen";
import { Page } from "@/components/ui";
import { getDebtDetail } from "@/db/queries/debt-detail";
import { routing } from "@/i18n/routing";

// The title and the screen read the same debt: memoised, the two renders of one
// request execute it once.
const readDebtDetail = cache(getDebtDetail);

export async function generateMetadata(
  props: PageProps<"/[locale]/planning/debts/[accountId]">,
): Promise<Metadata> {
  const { locale, accountId } = await props.params;
  if (!hasLocale(routing.locales, locale)) notFound();

  const t = await getTranslations({ locale, namespace: "debts" });
  const data = await readDebtDetail(accountId);

  // A debt the caller may not see names nothing: the area's own title stands in,
  // and the page below answers with `notFound()`.
  return { title: data === null ? t("title") : data.account.name };
}

export default async function DebtDetailPage(
  props: PageProps<"/[locale]/planning/debts/[accountId]">,
) {
  const { locale, accountId } = await props.params;
  if (!hasLocale(routing.locales, locale)) notFound();


  // No fan-out of its own: `getDebtDetail` IS one — five reads in a single
  // `Promise.all`, the group among them — so nothing here chains a second await.
  const data = await readDebtDetail(accountId);

  // Absent, not a liability, or outside the caller's read scope: one shape for
  // the three refusals. A `loading.tsx` sits above this route, so the streamed
  // `notFound()` answers 200 with `noindex` rather than a 404 status — Next's own
  // documented behaviour, and what `/movements/[id]` already does.
  if (data === null) notFound();

  return (
    // Every band of the detail carries the gutter itself from `md` up (SPEC-A3).
    <Page gutter="flush-md">
      <DebtDetailScreen data={data} />
    </Page>
  );
}
