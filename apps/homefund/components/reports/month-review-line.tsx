import { useFormatter, useTranslations } from "next-intl";

import { Card, PlainLink, Text } from "@/components/ui";
import { civilDateToDate } from "@/lib/dates";

// Inicio's «Revisar septiembre · 4 movimientos» (RF-155): last month still has
// items nobody marked, and the line opens that month's review.
export function MonthReviewLine({ month, count }: { month: string; count: number }) {
  const t = useTranslations("dashboard");
  const format = useFormatter();
  const monthName = format.dateTime(civilDateToDate(`${month}-01`), { month: "long" });

  return (
    <Card asChild>
      <PlainLink href={`/reports/review?month=${month}`}>
        <Text size="2" weight="medium">
          {t("reviewLine", { month: monthName, count })}
        </Text>
      </PlainLink>
    </Card>
  );
}
