import { getTranslations } from "next-intl/server";

import { BarRows } from "@/components/screens/app-rows";
import { AutoRefresh } from "@/components/screens/auto-refresh";
import { ClaudeBlock, InternetBlock } from "@/components/screens/claude-internet";
import { Between, Card, Cards, Figure, Hero, Split, Stack, Text, TextLink, Title } from "@/components/ui";
import { readableApp } from "@/lib/app-names";
import { claudeTotal } from "@/lib/daily";
import { appsBetween, claudeBetween, claudeSessionsBetween, dayTotals, pagesBetween, sitesBetween, uploadSpan, windowsBetween } from "@/lib/queries";
import { sum } from "@/lib/totals";
import { calendarWords } from "@/lib/words";
import { addDays, civilDay } from "@/lib/zone";

const TITLES_SHOWN = 8;

// One day (RT-04, RT-11): the total in the brand block, the top app and, on a past day, the gap to the day before, then the apps.
// «Hoy» is this screen for today; any past day opens on `/dia/AAAA-MM-DD`.
export async function DayView({ day }: { day: string }) {
  const today = civilDay();
  const isToday = day === today;
  const before = addDays(day, -1);
  const [raw, sites, pages, windows, sessions, claudeDays, previous, span, words, t] = await Promise.all([
    appsBetween(day, day),
    sitesBetween(day, day),
    pagesBetween(day, day),
    windowsBetween(day, day),
    claudeSessionsBetween(day, day),
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
  // Windows come under the readable name of their app, two processes with one name together.
  const titlesOf = new Map<string, typeof windows>();
  for (const one of windows) {
    const name = readableApp(one.app);
    if (name !== null) titlesOf.set(name, [...(titlesOf.get(name) ?? []), one]);
  }
  const total = sum(apps);
  const top = apps[0];
  const previousTotal = previous[0]?.seconds ?? 0;
  const delta = total - previousTotal;
  const date = t("title", { weekday: words.weekday(day), day: words.dayOfMonth(day), month: words.month(day) });
  const hasPrev = span.firstDay !== null && day > span.firstDay;
  const hasNext = day < today;
  const hrefOf = (target: string) => (target === today ? "/" : `/dia/${target}`);

  // Before the first upload there is nothing to read: no empty sections stand in for it.
  const firstUse = top === undefined && span.lastReceived === null;

  return (
    <Stack gap={4}>
      {isToday ? <AutoRefresh /> : null}
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
          {apps.length > 0 ? (
          <Stack gap={2}>
            <Text variant="meta">{t("apps")}</Text>
            <BarRows
              rows={apps.map((one) => ({
                key: one.app,
                name: one.app,
                figure: words.duration(one.seconds),
                seconds: one.seconds,
                label: t("bar", { app: one.app, duration: words.duration(one.seconds) }),
                detail: titlesOf.has(one.app) ? (
                  <>
                    <BarRows
                      rows={(titlesOf.get(one.app) ?? []).slice(0, TITLES_SHOWN).map((title) => ({
                        key: title.app + title.title,
                        name: title.title,
                        figure: words.duration(title.seconds),
                        seconds: title.seconds,
                        label: t("windowBar", { title: title.title, duration: words.duration(title.seconds) }),
                      }))}
                    />
                    {(titlesOf.get(one.app) ?? []).length > TITLES_SHOWN ? <Text as="p" variant="meta">{t("windowsMore", { n: (titlesOf.get(one.app) ?? []).length - TITLES_SHOWN })}</Text> : null}
                  </>
                ) : undefined,
              }))}
            />
          </Stack>
          ) : null}
          {firstUse ? null : <ClaudeBlock claude={claude} sessions={sessions} hasClaudeCode={span.hasClaudeCode} hasSites={span.hasSites} words={words} />}
          {firstUse ? null : <InternetBlock sites={sites} pages={pages} hasSites={span.hasSites} words={words} />}
        </Stack>
      </Split>
    </Stack>
  );
}
