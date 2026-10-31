import { getTranslations } from "next-intl/server";

import { BarRows } from "@/components/screens/app-rows";
import { Card, Cards, Figure, Hero, Stack, Text, TextLink, Title } from "@/components/ui";
import { appsBetween, dayTotals, uploadSpan } from "@/lib/queries";
import { sum } from "@/lib/totals";
import { calendarWords } from "@/lib/words";
import { addDays, civilDay } from "@/lib/zone";

// «Hoy» (RT-04): the day's total in the brand block, then today's apps, longest first.
export default async function TodayPage() {
  const today = civilDay();
  const yesterday = addDays(today, -1);
  const [raw, before, span, words, t] = await Promise.all([
    appsBetween(today, today),
    dayTotals(yesterday, yesterday),
    uploadSpan(),
    calendarWords(),
    getTranslations("time.today"),
  ]);
  const apps = words.apps(raw);
  const total = sum(apps);
  const top = apps[0];
  const yesterdayTotal = before[0]?.seconds ?? 0;
  const delta = total - yesterdayTotal;
  const date = t("title", { weekday: words.weekday(today), day: words.dayOfMonth(today), month: words.month(today) });

  return (
    <Stack gap={4}>
      <Hero>
        <Stack gap={3}>
          <Title small>{date}</Title>
          {top !== undefined ? (
            <>
              <Stack gap={2}>
                <Text variant="meta">{t("total")}</Text>
                <Figure parts={words.durationParts(total)} mark />
                {span.lastReceived !== null ? <Text variant="meta">{t("updated", { ago: words.ago(span.lastReceived) })}</Text> : null}
              </Stack>
              <Cards>
                <Card label={t("topApp")}>
                  <Text truncate>{top.app}</Text>
                  <Text mono>{words.duration(top.seconds)}</Text>
                </Card>
                {yesterdayTotal > 0 ? (
                  <Card label={t("versus")}>
                    <Text mono>
                      {delta === 0 ? t("versusSame") : t(delta > 0 ? "versusMore" : "versusLess", { duration: words.duration(Math.abs(delta)) })}
                    </Text>
                  </Card>
                ) : null}
              </Cards>
            </>
          ) : (
            <Text as="p">
              {span.lastReceived === null ? t("never") : `${t("empty")} · ${t("lastUpload", { when: words.moment(span.lastReceived) })}`}
            </Text>
          )}
        </Stack>
      </Hero>
      {top === undefined ? <TextLink button href="/llaves">{t("connect")}</TextLink> : null}
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
