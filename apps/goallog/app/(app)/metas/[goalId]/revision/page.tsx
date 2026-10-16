import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";

import { ReviewScreen } from "@/components/goal/review-screen";
import { getPerson } from "@/lib/session";

// Static per route: no title reads a goal or costs a statement (RNP-01).
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("common.titles");
  return { title: t("review") };
}

// `Revision.dc.html` / `RevisionEscritorio.dc.html` (RP-17): the auth gate
// alone, the same shape `app/(app)/metas/[goalId]/page.tsx` takes —
// `ReviewScreen` owns the fetch and the screen both.
export default async function ReviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ goalId: string }>;
  searchParams: Promise<{ todo?: string | string[] }>;
}) {
  const person = await getPerson();
  if (!person) redirect("/entrar");

  const { goalId } = await params;
  const { todo } = await searchParams;
  return <ReviewScreen goalId={goalId} all={todo === "1"} />;
}
