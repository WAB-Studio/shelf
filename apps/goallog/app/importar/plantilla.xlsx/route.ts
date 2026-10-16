import { createTranslator } from "next-intl";

import importMessages from "@/messages/es/import.json";
import { templateWorkbook, WORKBOOK_NAME } from "@/lib/import/workbook";

const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/**
 * The workbook of the template (RP-98): the bytes of `templateWorkbook()`. It reads no session
 * and no row; the file is the same for everyone.
 */
export async function GET() {
  // The catalogue read directly: `getTranslations` needs the request's server context, which a
  // route driven as a bare function (scripts/plan/import-route.ts) does not have.
  const t = createTranslator({ locale: "es", messages: { import: importMessages }, namespace: "import" }) as unknown as (key: string) => string;
  const bytes = await templateWorkbook(t);
  return new Response(bytes as BodyInit, {
    headers: {
      "Content-Type": XLSX_TYPE,
      "Content-Disposition": `attachment; filename=${WORKBOOK_NAME}`,
      "Cache-Control": "no-store",
    },
  });
}
