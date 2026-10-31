import { getTranslations } from "next-intl/server";

import { BarRows } from "@/components/screens/app-rows";
import { ClaudeBlock, InternetBlock } from "@/components/screens/claude-internet";
import { Between, Card, Cards, Figure, Hero, Split, Stack, Text, TextLink, Title } from "@/components/ui";
import { claudeTotal } from "@/lib/daily";
import { appsBetween, claudeBetween, dayTotals, sitesBetween, uploadSpan } from "@/lib/queries";
import { sum } from "@/lib/totals";
import { calendarWords } from "@/lib/words";
import { addDays, civilDay } from "@/lib/zone";

// One day (RT-04, RT-11): the total in the brand block, the top app and, on a past day, the gap to the day before, then the apps.
// «Hoy» is this screen for today; any past day opens on `/dia/AAAA-MM-DD`.
export async function DayView({ day }: { day: string }) {
  const today = civilDay();
  const isToday = day === today;
  const before = addDays(day, -1);
  const [raw, sites, claudeDays, previous, span, words, t] = await Promise.all([
    appsBetween(day, day),
    sitesBetween(day, day),
    claudeBetween(day, day),
    // Only a whole day compares: uploads carry day totals, so today so far has no like-for-like yesterday.
    isToday ? Promise.resolve([]) : dayTotals(before, before),
    uploadSpan(),
    calendarWords(),
    getTranslations("time.today"),
  ]);
  const claude = claudeDays[0];
  const claudeSeconds = claude === undefined ? 0 : claudeTotal(claude);
  const apps = words.apps(raw);
  const total = sum(apps);
  const top = apps[0];
  const previousTotal = previous[0]?.seconds ?? 0;
  const delta = total - previousTotal;
  const date = t("title", { weekday: words.weekday(day), day: words.dayOfMonth(day), month: words.month(day) });
  const hasPrev = span.firstDay !== null && day > span.firstDay;
  const hasNext = day < today;
  const hrefOf = (target: string) => (target === today ? "/" : `/dia/${target}`);

  return (
    <Stack gap={4}>
      {hasPrev || hasNext ? (
        <Between>
          {hasPrev ? <TextLink href={hrefOf(before)}>‹ {t("prev")}</TextLink> : <span />}
          {hasNext ? <TextLink href={hrefOf(addDays(day, 1))}>{t("next")} ›</TextLink> : null}
        </Between>
      ) : null}
      <Split
        aside={
          <Stack gap={3}>
          <Hero>
            <Stack gap={3}>
              <Title small>{date}</Title>
              {top !== undefined ? (
                <>
                  <Stack gap={2}>
                    <Text variant="meta">{t(isToday ? "total" : "totalPast")}</Text>
                    <Figure parts={words.durationParts(total)} mark />
                    {isToday && span.lastReceived !== null ? <Text variant="meta">{t("updated", { ago: words.ago(span.lastReceived) })}</Text> : null}
                  </Stack>
                  <Cards>
                    <Card label={t("topApp")}>
                      <Text truncate>{top.app}</Text>
                      <Text mono>{words.duration(top.seconds)}</Text>
                    </Card>
                    <Card label={t("claudeCard")}>
                      <Text mono>{claudeSeconds > 0 ? words.duration(claudeSeconds) : "—"}</Text>
                    </Card>
                    {!isToday && previousTotal > 0 ? (
                      <Card label={t("versus")}>
                        <Text mono>
                          {delta === 0 ? t("versusSame") : t(delta > 0 ? "versusMore" : "versusLess", { duration: words.duration(Math.abs(delta)) })}
                        </Text>
                      </Card>
                    ) : null}
                  </Cards>
                </>
              ) : (
                <Stack gap={2}>
                  <Text as="p">{span.lastReceived === null ? t("never") : t(isToday ? "empty" : "emptyPast")}</Text>
                  {span.lastReceived === null ? null : <Text as="p" variant="meta">{t(isToday ? "emptyWhy" : "emptyPastWhy")}</Text>}
                  {span.lastReceived === null ? null : <Text as="p" variant="meta">{t("lastUpload", { when: words.moment(span.lastReceived) })}</Text>}
                </Stack>
              )}
            </Stack>
          </Hero>
            {top === undefined && span.lastReceived === null ? <TextLink button href="/llaves">{t("connect")}</TextLink> : null}
          </Stack>
        }
      >
        <Stack gap={4}>
          <Stack gap={2}>
            <Text variant="meta">{t("apps")}</Text>
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
          <ClaudeBlock claude={claude} hasClaudeCode={span.hasClaudeCode} hasSites={span.hasSites} words={words} />
          <InternetBlock sites={sites} hasSites={span.hasSites} words={words} />
        </Stack>
      </Split>
    </Stack>
  );
}
