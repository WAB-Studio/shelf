import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { Between, Card, Cards, DayColumns, Figure, Heatmap, Hero, HeroColumns, Stack, Text, TextLink, Tile, Title } from "@/components/ui";
import { claudeTotal } from "@/lib/daily";
import { buildHeatmap } from "@/lib/heatmap";
import { appsByDay, claudeBetween, dayTotals, uploadSpan } from "@/lib/queries";
import { fill, sum } from "@/lib/totals";
import { askedWeek, clampWeek, weekSteps } from "@/lib/week";
import { calendarWords } from "@/lib/words";
import { addDays, civilDay } from "@/lib/zone";

const APPS_SHOWN = 8;

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
  const [span, totals, byDay, claude, words, t] = await Promise.all([
    uploadSpan(),
    dayTotals(asked, sunday),
    appsByDay(asked, sunday),
    claudeBetween(asked, sunday),
    calendarWords(),
    getTranslations("time.week"),
  ]);
  const monday = clampWeek(asked, span.firstDay, today);
  if (monday !== asked) redirect(`/semana?semana=${monday}`);
  const steps = weekSteps(monday, span.firstDay, today);
  const days = fill(monday, sunday, totals);
  const longestDay = Math.max(1, ...days.map((one) => one.seconds));
  const heat = buildHeatmap(byDay, days.map((one) => one.day), words.system, APPS_SHOWN);
  const claudeWeek = claude.reduce((total, one) => total + claudeTotal(one), 0);

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
            {claudeWeek === 0 ? <Text variant="meta">{span.hasClaudeCode || span.hasSites ? t("claudeNone") : t("claudeNever")}</Text> : null}
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
      <Tile full title={t("apps")} figure={words.duration(sum(totals))}>
        {heat.rows.length === 0 ? (
          <Text as="p">{t("noApps")}</Text>
        ) : (
          <>
            <Heatmap
              label={t("heatmap")}
              columns={days.map(({ day }) => ({ key: day, label: words.weekdayShort(day), href: day === today ? "/" : `/dia/${day}`, future: day > today }))}
              rows={heat.rows.map((row) => ({
                key: row.app,
                name: row.app,
                tone: row.kind,
                total: words.duration(row.total),
                cells: row.cells.map((cell, index) => {
                  const day = days[index].day;
                  const when = `${words.weekdayShort(day)} ${words.dayOfMonth(day)}`;
                  return {
                    figure: cell.seconds === 0 ? null : words.heat(cell.seconds),
                    level: cell.level,
                    label: t("cell", { app: row.app, day: when, duration: cell.seconds === 0 ? t("none") : words.duration(cell.seconds) }),
                  };
                }),
              }))}
            />
            {heat.restCount > 0 ? <Text as="p" variant="meta">{t("appsMore", { n: heat.restCount, duration: words.duration(heat.restSeconds) })}</Text> : null}
          </>
        )}
        <Between>
          <TextLink download href={`/api/export?from=${monday}&to=${sunday}`}>
            {t("export")}
          </TextLink>
          <TextLink href="/exportar">{t("exportMore")} ›</TextLink>
        </Between>
      </Tile>
    </Stack>
  );
}
