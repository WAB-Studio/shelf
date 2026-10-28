import { useFormatter, useTranslations } from "next-intl";

import { Card, Link, TapTarget } from "@/components/ui";
import { Link as LocaleLink } from "@/i18n/navigation";
import { civilDateToDate } from "@/lib/dates";

// Inicio's «Revisar septiembre · 4 movimientos» (RF-155): last month still has
// items nobody marked, and the line opens that month's review.
export function MonthReviewLine({ month, count }: { month: string; count: number }) {
  const t = useTranslations("dashboard");
  const format = useFormatter();
  const monthName = format.dateTime(civilDateToDate(`${month}-01`), { month: "long" });

  return (
    <Card>
      <Link asChild size="2" weight="medium">
        <LocaleLink href={`/reports/review?month=${month}`}>
          <TapTarget align="center">{t("reviewLine", { month: monthName, count })}</TapTarget>
        </LocaleLink>
      </Link>
    </Card>
  );
}
