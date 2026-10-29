import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";

import { ReviewScreen } from "@/components/import/review-screen";
import { loadImportSnapshots } from "@/lib/queries/import-match";
import { getPerson } from "@/lib/session";
import { todayInZone } from "@/lib/zone";

// Static per route: no title reads a goal or costs a statement (RNP-01).
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("common.titles");
  return { title: t("importReview") };
}

// The auth gate, today's day and a snapshot of every open goal, for the review to match the draft's goals
// against (RP-130); the draft itself lives in the tab's storage, so the client reads it (RP-37) and the
// names to match are not known here.
export default async function ImportReviewPage() {
  const person = await getPerson();
  if (!person) redirect("/entrar");

  const snapshots = await loadImportSnapshots(null);

  return <ReviewScreen today={todayInZone()} snapshots={snapshots} />;
}
