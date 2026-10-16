import { hasLocale } from "next-intl";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import type { NextRequest } from "next/server";

import { readExport } from "@/db/queries/export";
import type { TransactionExportFilters } from "@/db/queries/export";
import { requireUser } from "@/db/session";
import { TIME_ZONE } from "@/lib/locales";
import { SHEET_ENTITIES, type SheetEntity } from "@/lib/spreadsheet/schema";
import { buildWorkbook, type SheetLabels } from "@/lib/spreadsheet/workbook";
import { movementFiltersSchema } from "@/lib/validation/transaction";
import { routing } from "@/i18n/routing";

// ExcelJS writes with Node streams and zlib, so the workbook build stays on the
// Node runtime.
export const runtime = "nodejs";

const SPREADSHEET_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

// The caller's own Bogotá day (RNF-06), for a filename a person recognizes.
function todayInBogota(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE }).format(new Date());
}

// The requested entities, from a comma-separated list or repeated `entities` keys;
// anything unknown is dropped and an empty selection falls back to all five (RF-50).
function requestedEntities(params: URLSearchParams): SheetEntity[] {
  const known = SHEET_ENTITIES as readonly string[];
  const picked = params
    .getAll("entities")
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value): value is SheetEntity => known.includes(value));

  const unique = SHEET_ENTITIES.filter((entity) => picked.includes(entity));
  return unique.length > 0 ? unique : [...SHEET_ENTITIES];
}

/**
 * The export download (RF-50, RF-118). Streams an `.xlsx` of the caller's rows —
 * one sheet per requested entity, headers and tab names localized, references
 * shown as names, money as decimal in each row's own currency (RF-121). RLS in `readExport` bounds every row to
 * the caller's scope. The query carries the movement list's own filters, parsed
 * by the schema that page and its filter bar parse (RNF-10), so the transactions
 * sheet holds exactly the rows the list shows; with none it holds them all.
 */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ locale: string }> },
): Promise<Response> {
  const { locale } = await context.params;
  if (!hasLocale(routing.locales, locale)) notFound();

  const params = request.nextUrl.searchParams;
  const entityKeys = requestedEntities(params);
  const filters = movementFiltersSchema.parse(Object.fromEntries(params));

  // The type chip maps to the generated `kind`; "all" drops the predicate so the
  // sheet carries every kind, the transfers RF-19 keeps out of reports included.
  const transactionFilters: TransactionExportFilters = {
    kind: filters.type === "all" ? undefined : filters.type,
    memberUserId: filters.member,
    accountId: filters.account,
    categoryId: filters.category,
    labelId: filters.label,
    unreviewed: filters.unreviewed,
    recurringRuleId: filters.rule,
  };

  const [, data, t] = await Promise.all([
    requireUser(),
    readExport({
      entityKeys,
      from: filters.from,
      to: filters.to,
      transactionFilters,
    }),
    getTranslations({ locale, namespace: "data" }),
  ]);

  const labels: SheetLabels = {
    sheetName: (entity) => t(`sheets.${entity}`),
    // The key is a descriptor column key, a fixed member of `data.columns`, but its
    // static type is a bare string, so the catalogue lookup is asserted.
    columnHeader: (key) => t(`columns.${key}` as Parameters<typeof t>[0]),
  };

  const workbook = buildWorkbook({ data, labels });
  const buffer = await workbook.xlsx.writeBuffer();
  const filename = `${t("filenames.export")}-${todayInBogota()}.xlsx`;

  return new Response(buffer, {
    headers: {
      "Content-Type": SPREADSHEET_CONTENT_TYPE,
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
