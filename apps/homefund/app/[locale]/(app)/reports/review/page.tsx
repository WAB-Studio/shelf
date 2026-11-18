import { hasLocale } from "next-intl";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";

import { MonthReviewScreen } from "@/components/reports/month-review-screen";
import { Page } from "@/components/ui";
import { getFixItems } from "@/db/queries/home-lines";
import { getMonthReview } from "@/db/queries/month-review";
import { listCallerMembers } from "@/db/queries/group-members";
import { getSessionUser } from "@/db/session";
import { redirect } from "@/i18n/navigation";
import { routing } from "@/i18n/routing";
import { MONTH_PATTERN, currentMonthStart } from "@/lib/dates";


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

// RF-155: a month's review. `?month=` names one; absent, the current month, where what is odd now («Por arreglar»)
// joins the movements that stand out. A month yet to come, malformed, or before the first movement lands on this one.
export default async function MonthReviewPage(props: ReviewPageProps) {
  const [{ locale }, { month: raw }] = await Promise.all([props.params, props.searchParams]);
  if (!hasLocale(routing.locales, locale)) notFound();

  const current = currentMonthStart().slice(0, 7);
  if (raw !== undefined && (typeof raw !== "string" || !MONTH_PATTERN.test(raw) || raw > current)) {
    return redirect({ href: "/reports/review", locale });
  }
  const month = raw ?? current;
  const user = await getSessionUser();
  const [review, members, fixes] = await Promise.all([
    getMonthReview(month),
    user ? listCallerMembers(user.id, { archived: "all" }) : Promise.resolve([]),
    month === current ? getFixItems() : Promise.resolve([]),
  ]);
  if (raw !== undefined && review.firstMonth !== null && month < review.firstMonth) {
    return redirect({ href: "/reports/review", locale });
  }

  // Who entered each of a twin's movements: a member's name, or the caller's own email.
  const creatorNames: Record<string, string> = user ? { [user.id]: user.email } : {};
  for (const member of members) if (member.userId) creatorNames[member.userId] = member.name;

  return (
    <Page>
      <MonthReviewScreen review={review} lastMonth={current} fixes={fixes} creatorNames={creatorNames} />
    </Page>
  );
}
