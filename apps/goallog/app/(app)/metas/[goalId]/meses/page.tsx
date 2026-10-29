import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";

import { MonthsScreen } from "@/components/month/months-screen";
import { returnTo } from "@/lib/plan/return-to";
import { getPerson } from "@/lib/session";

// Static per route: no title reads a goal or costs a statement (RNP-01).
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("common.titles");
  return { title: t("months") };
}

// `Meses.dc.html` / `MesesVacio.dc.html` / `MesesEscritorio` (RP-32): the auth
// gate alone; `MonthsScreen` owns the fetch. `?planear=YYYY-MM` opens the
// amount sheet on that month.
export default async function MonthsPage({
  params,
  searchParams,
}: {
  params: Promise<{ goalId: string }>;
  searchParams: Promise<{ planear?: string | string[]; volver?: string | string[]; todo?: string | string[] }>;
}) {
  const person = await getPerson();
  if (!person) redirect("/entrar");

  const { goalId } = await params;
  const { planear, volver, todo } = await searchParams;
  const keep = [
    typeof planear === "string" ? `planear=${encodeURIComponent(planear)}` : null,
    typeof volver === "string" ? `volver=${encodeURIComponent(volver)}` : null,
  ]
    .filter((part) => part !== null)
    .join("&");
  return (
    <MonthsScreen
      goalId={goalId}
      planning={typeof planear === "string" ? planear : null}
      returnPath={returnTo(typeof volver === "string" ? volver : null, goalId)}
      all={todo === "1"}
      keep={keep}
    />
  );
}
