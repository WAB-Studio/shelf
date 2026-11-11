import { hasLocale } from "next-intl";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";

import { MonthReviewScreen } from "@/components/reports/month-review-screen";
import { Page } from "@/components/ui";
import { getMonthReview } from "@/db/queries/month-review";
import { resolveCreatorNames } from "@/db/queries/transaction-form";
import { redirect } from "@/i18n/navigation";
import { routing } from "@/i18n/routing";
import { MONTH_PATTERN, lastClosedMonth } from "@/lib/dates";


type ReviewPageProps = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ month?: string | string[] }>;
};

export async function generateMetadata(props: ReviewPageProps): Promise<Metadata> {
  const { locale } = await props.params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const t = await getTranslations({ locale, namespace: "review" });
  return { title: t("entry") };
}

// RF-155: a closed month's review. `?month=` names one; absent, last month. A month
// not yet closed, malformed, or before the first movement lands on last month.
export default async function MonthReviewPage(props: ReviewPageProps) {
  const [{ locale }, { month: raw }] = await Promise.all([props.params, props.searchParams]);
  if (!hasLocale(routing.locales, locale)) notFound();

  const lastClosed = lastClosedMonth();
  if (raw !== undefined && (typeof raw !== "string" || !MONTH_PATTERN.test(raw) || raw > lastClosed)) {
    return redirect({ href: "/reports/review", locale });
  }
  const month = raw ?? lastClosed;
  const review = await getMonthReview(month);
  if (raw !== undefined && review.firstMonth !== null && month < review.firstMonth) {
    return redirect({ href: "/reports/review", locale });
  }

  // Who entered each of a twin's movements, by the id the item carries.
  const creatorNames = Object.fromEntries(
    await resolveCreatorNames(review.items.flatMap((item) => item.entries.map((entry) => entry.createdBy))),
  );

  return (
    <Page>
      <MonthReviewScreen review={review} lastClosed={lastClosed} creatorNames={creatorNames} />
    </Page>
  );
}
