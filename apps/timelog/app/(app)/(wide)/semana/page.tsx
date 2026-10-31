import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { BarRows } from "@/components/screens/app-rows";
import { Between, Card, Cards, DayColumns, Figure, Hero, HeroColumns, Mosaic, Stack, Text, TextLink, Tile, Title } from "@/components/ui";
import { claudeTotal } from "@/lib/daily";
import { appsBetween, claudeBetween, dayTotals, uploadSpan } from "@/lib/queries";
import { fill, sum } from "@/lib/totals";
import { askedWeek, clampWeek, weekSteps } from "@/lib/week";
import { calendarWords } from "@/lib/words";
import { addDays, civilDay } from "@/lib/zone";

export async function generateMetadata({ searchParams }: { searchParams: Promise<{ semana?: string }> }): Promise<Metadata> {
  const { semana } = await searchParams;
  const monday = askedWeek(semana, civilDay());
  const [words, t] = await Promise.all([calendarWords(), getTranslations("time.week")]);
  return { title: t("title", { from: words.dayShort(monday), to: words.dayShort(addDays(monday, 6)) }) };
}

// «Semana» (RT-05). The span arrives with the week's reads, so a week past it redirects to its nearer end.
export default async function WeekPage({ searchParams }: { searchParams: Promise<{ semana?: string }> }) {
  const today = civilDay();
  const { semana } = await searchParams;
  const asked = askedWeek(semana, today);
  const sunday = addDays(asked, 6);
  const [span, totals, apps, claude, words, t] = await Promise.all([
    uploadSpan(),
    dayTotals(asked, sunday),
    appsBetween(asked, sunday),
    claudeBetween(asked, sunday),
    calendarWords(),
    getTranslations("time.week"),
  ]);
  const monday = clampWeek(asked, span.firstDay, today);
  if (monday !== asked) redirect(`/semana?semana=${monday}`);
  const steps = weekSteps(monday, span.firstDay, today);
  const days = fill(monday, sunday, totals);
  const longestDay = Math.max(1, ...days.map((one) => one.seconds));
  const grouped = words.apps(apps);
  const claudeOn = new Map(claude.map((one) => [one.day, claudeTotal(one)]));
  const claudeWeek = [...claudeOn.values()].reduce((total, seconds) => total + seconds, 0);

  const block = (
    <Hero>
      <HeroColumns>
        <Stack gap={2}>
          <Text variant="meta">{t("total")}</Text>
          <Figure parts={words.durationParts(sum(totals))} />
        </Stack>
        <DayColumns
          days={days.map(({ day, seconds }) => {
            const name = `${words.weekdayShort(day)} ${words.dayOfMonth(day)}`;
            const future = day > today;
            return {
              key: day,
              label: words.weekdayShort(day),
              figure: seconds === 0 ? t("none") : words.brief(seconds),
              share: seconds / longestDay,
              future,
              href: day === today ? "/" : `/dia/${day}`,
              description: future ? t("upcoming", { day: name }) : t("bar", { day: name, duration: seconds === 0 ? t("none") : words.duration(seconds) }),
            };
          })}
        />
        <Cards>
          <Card label={t("claudeWeekTotal")}>
            <Text mono>{claudeWeek > 0 ? words.duration(claudeWeek) : t("none")}</Text>
          </Card>
        </Cards>
      </HeroColumns>
    </Hero>
  );

  return (
    <Stack gap={4}>
      <Between>
        <Title>{t("title", { from: words.dayShort(monday), to: words.dayShort(sunday) })}</Title>
        <Between>
          {steps.prev ? <TextLink href={`/semana?semana=${steps.prev}`}>‹ {t("prev")}</TextLink> : null}
          {steps.next ? <TextLink href={`/semana?semana=${steps.next}`}>{t("next")} ›</TextLink> : null}
        </Between>
      </Between>
      {block}
      <Mosaic>
          <Tile lead title={t("apps")}>
            {grouped.length === 0 ? (
              <Text as="p">{t("noApps")}</Text>
            ) : (
              <BarRows
                featured={3}
                rows={grouped.map((one) => ({
                  key: one.app,
                  name: one.app,
                  figure: words.duration(one.seconds),
                  seconds: one.seconds,
                  label: t("bar", { day: one.app, duration: words.duration(one.seconds) }),
                }))}
              />
            )}
          </Tile>
          <Tile title={t("claude")}>
            <TextLink download href={`/api/export?from=${monday}&to=${sunday}`}>
              {t("export")}
            </TextLink>
            {claudeWeek === 0 ? (
              <Text as="p" variant="meta">{span.hasClaudeCode || span.hasSites ? t("claudeNone") : t("claudeNever")}</Text>
            ) : (
              <BarRows
                rows={days.map(({ day }) => {
                  const seconds = claudeOn.get(day) ?? 0;
                  const name = `${words.weekdayShort(day)} ${words.dayOfMonth(day)}`;
                  return {
                    key: day,
                    name,
                    figure: seconds === 0 ? t("none") : words.duration(seconds),
                    seconds,
                    label: t("bar", { day: name, duration: seconds === 0 ? t("none") : words.duration(seconds) }),
                  };
                })}
              />
            )}
          </Tile>
      </Mosaic>
    </Stack>
  );
}
