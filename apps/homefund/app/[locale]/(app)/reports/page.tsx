import { hasLocale } from "next-intl";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { z } from "zod";

import { ReportsScreen } from "@/components/reports/reports-screen";
import { Page } from "@/components/ui";
import { getReportsData } from "@/db/queries/reports/reports-screen";
import { routing } from "@/i18n/routing";
import { MONTH_PATTERN, todayInBogota } from "@/lib/dates";

// A malformed `?month` falls back to the current Bogotá month, as Presupuestos does.
const monthSchema = z
  .string()
  .regex(MONTH_PATTERN)
  .catch(() => todayInBogota().slice(0, 7));

export async function generateMetadata(
  props: PageProps<"/[locale]/reports">,
): Promise<Metadata> {
  const { locale } = await props.params;
  if (!hasLocale(routing.locales, locale)) notFound();

  const t = await getTranslations({ locale, namespace: "reports" });

  return { title: t("title") };
}

export default async function ReportsPage(
  props: PageProps<"/[locale]/reports">,
) {
  const { locale } = await props.params;
  if (!hasLocale(routing.locales, locale)) notFound();


  // A month that has not begun has nothing to read: it clamps to the current one.
  const requested = monthSchema.parse((await props.searchParams).month);
  const current = todayInBogota().slice(0, 7);
  const month = requested > current ? current : requested;

  const data = await getReportsData(`${month}-01`);

  return (
    <Page>
      <ReportsScreen data={data} month={month} />
    </Page>
  );
}
