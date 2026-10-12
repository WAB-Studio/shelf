import { templateWorkbook, WORKBOOK_NAME } from "@/lib/import/workbook";

const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/**
 * The workbook of the template (RP-98): the bytes of `templateWorkbook()`. It reads no session
 * and no row; the file is the same for everyone.
 */
export async function GET() {
  const bytes = await templateWorkbook();
  return new Response(bytes as BodyInit, {
    headers: {
      "Content-Type": XLSX_TYPE,
      "Content-Disposition": `attachment; filename=${WORKBOOK_NAME}`,
      "Cache-Control": "no-store",
    },
  });
}
