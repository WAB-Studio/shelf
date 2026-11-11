import { hasLocale } from "next-intl";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import type { NextRequest } from "next/server";

import { readExportOptions } from "@/db/queries/export";
import { requireUser } from "@/db/session";
import { TIME_ZONE } from "@/lib/locales";
import { type SheetLabels, buildTemplate, choiceLabelFrom } from "@/lib/spreadsheet/workbook";
import { routing } from "@/i18n/routing";

// ExcelJS writes with Node streams and zlib; the name read is user-scoped.
export const runtime = "nodejs";

const SPREADSHEET_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function todayInBogota(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE }).format(new Date());
}

/**
 * The fill-in template download (RF-49). Streams an `.xlsx` of every sheet,
 * the export's own layout without rows: account, category and closed-set columns offer
 * dropdowns sourced from a hidden options sheet. The name read is
 * RLS-bound, so the options never exceed what the caller can write back on import.
 */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ locale: string }> },
): Promise<Response> {
  const { locale } = await context.params;
  if (!hasLocale(routing.locales, locale)) notFound();

  const [, source, t] = await Promise.all([
    requireUser(),
    readExportOptions(),
    getTranslations({ locale, namespace: "data" }),
  ]);

  const labels: SheetLabels = {
    sheetName: (entity) => t(`sheets.${entity}`),
    // The key is a descriptor column key, a fixed member of `data.columns`, but its
    // static type is a bare string, so the catalogue lookup is asserted.
    columnHeader: (key) => t(`columns.${key}` as Parameters<typeof t>[0]),
    choiceLabel: choiceLabelFrom(t),
  };

  const workbook = buildTemplate({
    labels,
    options: source,
  });
  const buffer = await workbook.xlsx.writeBuffer();
  const filename = `${t("filenames.template")}-${todayInBogota()}.xlsx`;

  return new Response(buffer, {
    headers: {
      "Content-Type": SPREADSHEET_CONTENT_TYPE,
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
