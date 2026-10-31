import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { BarRows } from "@/components/screens/app-rows";
import { Between, Card, Cards, DayColumns, Disclosure, Figure, Heatmap, Hero, HeroColumns, Stack, Text, TextLink, Tile, Title, ToneLegend } from "@/components/ui";
import { claudeTotal, claudeWeekHint } from "@/lib/daily";
import { appTone } from "@/lib/app-classes";
import { buildHeatmap, claudeHeatRow } from "@/lib/heatmap";
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
  const [span, totals, byDay, claude, words, t, tClaude, tClass] = await Promise.all([
    uploadSpan(),
    dayTotals(asked, sunday),
    appsByDay(asked, sunday),
    claudeBetween(asked, sunday),
    calendarWords(),
    getTranslations("time.week"),
    getTranslations("time.claude"),
    getTranslations("time.classes"),
  ]);
  const monday = clampWeek(asked, span.firstDay, today);
  if (monday !== asked) redirect(`/semana?semana=${monday}`);
  const steps = weekSteps(monday, span.firstDay, today);
  const days = fill(monday, sunday, totals);
  const longestDay = Math.max(1, ...days.map((one) => one.seconds));
  const heat = buildHeatmap(byDay, days.map((one) => one.day), words.system, APPS_SHOWN);
  const hint = claudeWeekHint(span);
  // Claude's total is the grid's first row, levelled against its largest app cell; every tone in it is also written, in the row and in the legend.
  const largest = Math.max(1, ...heat.rows.flatMap((row) => row.cells.map((cell) => cell.seconds)));
  const claudeRow = claudeHeatRow(claude, days.map((one) => one.day), largest);
  const toneName = (tone: ReturnType<typeof appTone> | "claude") => (tone === "claude" ? tClaude("title") : tone === "claudeApp" ? tClaude("desktop") : tClass(tone));
  const cellOf = (app: string, day: string, cell: { seconds: number; level: number }) => ({
    figure: cell.seconds === 0 ? null : words.heat(cell.seconds),
    level: cell.level,
    label: t("cell", { app, day: `${words.weekdayShort(day)} ${words.dayOfMonth(day)}`, duration: cell.seconds === 0 ? t("none") : words.duration(cell.seconds) }),
  });
  const heatRows = [
    ...(claudeRow.total === 0 ? [] : [{ key: "claude-total", name: tClaude("total"), kind: toneName("claude"), tone: "claude" as const, total: words.duration(claudeRow.total), cells: claudeRow.cells.map((cell, index) => cellOf(tClaude("total"), days[index].day, cell)) }]),
    ...heat.rows.map((row) => {
      const tone = appTone(row.app, words.system);
      return { key: row.app, name: row.app, kind: toneName(tone), tone, total: words.duration(row.total), cells: row.cells.map((cell, index) => cellOf(row.app, days[index].day, cell)) };
    }),
  ];
  const restTones = heat.rest.map((one) => appTone(one.app, words.system));
  const legend = [...new Map([...heatRows.map((row) => row.tone), ...restTones].map((tone) => [tone, { key: tone, tone, name: toneName(tone) }])).values()];
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
            {claudeWeek === 0 ? <Text variant="meta">{t(`claudeHint.${hint}`)}</Text> : null}
            {claudeWeek === 0 && hint === "connect" ? <TextLink href="/llaves">{t("connect")} ›</TextLink> : null}
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
        {heatRows.length === 0 ? (
          <Text as="p">{t("noApps")}</Text>
        ) : (
          <>
            <Heatmap
              label={t("heatmap")}
              columns={days.map(({ day }) => ({ key: day, label: words.weekdayShort(day), href: day === today ? "/" : `/dia/${day}`, future: day > today }))}
              rows={heatRows}
            />
            <ToneLegend items={legend} />
            {heat.restCount > 0 ? (
              <Disclosure summary={<Text variant="meta">{t("appsMore", { n: heat.restCount, duration: words.duration(heat.restSeconds) })}</Text>}>
                <BarRows
                  of={heat.rows[0]?.total}
                  rows={heat.rest.map((one) => ({ key: one.app, name: one.app, tone: appTone(one.app, words.system), figure: words.duration(one.total), seconds: one.total, label: t("restBar", { app: one.app, duration: words.duration(one.total) }) }))}
                />
              </Disclosure>
            ) : null}
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
