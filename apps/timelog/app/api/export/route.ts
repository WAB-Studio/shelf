import { getTranslations } from "next-intl/server";

import { dailyRows, toCsv } from "@/lib/daily";
import { exportRange, rangeRetry } from "@/lib/export-range";
import { appsByDay, claudeBetween, dayTotals, uploadedDays } from "@/lib/queries";
import { getPerson } from "@/lib/session";
import { civilDay } from "@/lib/zone";

export const runtime = "nodejs";

const to = (request: Request, path: string) => Response.redirect(new URL(path, request.url), 303);

// The daily CSV (RT-15): one row per day of the range, the same rows `get_daily` answers. The person's session
// reads it; a bad range goes back to the form with its reason.
export async function GET(request: Request): Promise<Response> {
  if ((await getPerson()) === null) return to(request, "/entrar");

  const params = new URL(request.url).searchParams;
  const range = exportRange.safeParse({ from: params.get("from"), to: params.get("to") });
  if (!range.success) return to(request, rangeRetry(params.get("from"), params.get("to")));

  const { from, to: until } = range.data;
  const [totals, claude, apps, uploaded, t] = await Promise.all([
    dayTotals(from, until),
    claudeBetween(from, until),
    appsByDay(from, until),
    uploadedDays(from, until),
    getTranslations("time"),
  ]);
  return new Response(toCsv(dailyRows(from, until, totals, claude, apps, t("system"), civilDay(), new Set(uploaded))), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="timelog-${from}_${until}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
