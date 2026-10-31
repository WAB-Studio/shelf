import { getTranslations } from "next-intl/server";

import { BarRows } from "@/components/screens/app-rows";
import { Hero, Stack, Text, Title } from "@/components/ui";
import { appsBetween, uploadSpan } from "@/lib/queries";
import { sum } from "@/lib/totals";
import { calendarWords } from "@/lib/words";
import { civilDay } from "@/lib/zone";

// «Hoy» (RT-04): today's apps, longest first, and the day's total.
export default async function TodayPage() {
  const today = civilDay();
  const [apps, span, words, t] = await Promise.all([appsBetween(today, today), uploadSpan(), calendarWords(), getTranslations("time.today")]);
  const total = sum(apps);

  return (
    <Stack gap={4}>
      <Hero>
        <Stack gap={2}>
          <Title>{t("title", { weekday: words.weekday(today), day: words.dayOfMonth(today), month: words.month(today) })}</Title>
          {apps.length > 0 ? (
            <Text variant="meta">
              {t("total")} <Text variant="total" mono mark>{words.duration(total)}</Text>
            </Text>
          ) : (
            <Text variant="meta" as="p">
              {span.lastReceived === null ? t("never") : `${t("empty")} · ${t("lastUpload", { when: words.moment(span.lastReceived) })}`}
            </Text>
          )}
        </Stack>
      </Hero>
      <BarRows
        rows={apps.map((one) => ({
          key: one.app,
          name: one.app,
          figure: words.duration(one.seconds),
          seconds: one.seconds,
          label: t("bar", { app: one.app, duration: words.duration(one.seconds) }),
        }))}
      />
    </Stack>
  );
}
