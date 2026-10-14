import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { ReportScreen } from "@/components/export/report-screen";
import { loadReport } from "@/lib/queries/report";
import { getPerson } from "@/lib/session";
import { civilDateShort, todayInZone } from "@/lib/zone";

// The browser proposes the title as the PDF's file name.
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("export");
  return { title: { absolute: `${t("printBrand")} · ${civilDateShort(todayInZone())}` } };
}

// Inside the shell: the nav hides itself in print (`print.module.css`) and the
// skeleton never prints, so the paper stays as `ReporteImpreso.dc.html` draws it.
export default async function ExportPage({
  searchParams,
}: {
  searchParams: Promise<{ todo?: string | string[] }>;
}) {
  const person = await getPerson();
  if (!person) redirect("/entrar");

  const { todo } = await searchParams;
  const report = await loadReport(todayInZone());
  return <ReportScreen report={report} showAll={todo === "1"} />;
}
