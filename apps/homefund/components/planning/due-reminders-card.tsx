import { useFormatter, useTranslations } from "next-intl";

import { Card, Flex, Heading, Money, PlainLink, Text, TextLink } from "@/components/ui";
import type { DueReminder } from "@/db/queries/due-reminders";
import { civilDateToDate, todayInBogota } from "@/lib/dates";
import type { CurrencyCode } from "@/lib/currency";

// «Por pagar» on Inicio (RF-159): the payments whose reminder has come, each a
// way into Pagos. The link counts them all when the list is cut short. Renders
// nothing for an empty list; the screen decides there is no card.
export function DueRemindersCard({
  rows,
  total,
}: {
  rows: DueReminder[];
  total: number;
}) {
  const t = useTranslations("dashboard");
  const format = useFormatter();
  const today = todayInBogota();

  if (rows.length === 0) return null;

  return (
    <Card>
      <Flex direction="column" gap="2">
        <Flex justify="between" align="baseline" gap="3">
          <Heading as="h2" size="4">{t("dueTitle")}</Heading>
          <TextLink href="/planning/payments" size="2" weight="medium">
            {total > rows.length ? t("dueSeeAll", { count: total }) : t("dueSee")}
          </TextLink>
        </Flex>

        {rows.map((row) => {
          const late = row.dueDate < today;
          const date = format.dateTime(civilDateToDate(row.dueDate), {
            day: "numeric",
            month: "short",
          });
          return (
            <PlainLink key={row.id} href="/planning/payments">
              <Flex align="center" gap="3">
                <Flex direction="column" flexGrow="1" minWidth="0">
                  <Text size="3" weight="medium" truncate>
                    {row.description ?? t("dueNoName")}
                  </Text>
                  <Text size="2" color={late ? "red" : "gray"}>
                    {t(late ? "dueLate" : "dueSoon", { date })}
                  </Text>
                </Flex>
                <Money
                  minor={row.amountCents}
                  currency={row.currency as CurrencyCode}
                  signed={false}
                />
              </Flex>
            </PlainLink>
          );
        })}
      </Flex>
    </Card>
  );
}
