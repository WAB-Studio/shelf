import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { BarRows, type BarRow } from "@/components/screens/app-rows";
import { ClaudeLine, ProjectBars, SiteBars } from "@/components/screens/claude-internet";
import { Between, Composition, DayRows, Period, Section, Stack, Text, TextLink } from "@/components/ui";
import { appTone, mainSiteClass, timeByClass } from "@/lib/app-classes";
import { displayApp } from "@/lib/app-names";
import { claudeScreen } from "@/lib/daily";
import { withTimeDb } from "@/lib/session";
import { appsByDay, claudeBetween, claudeSessionsBetween, dayTotals, editorWindowsBetween, pagesBetween, sitesBetween, uploadSpan } from "@/lib/queries";
import { fill, sum } from "@/lib/totals";
import { projectsOf } from "@/lib/vscode-project";
import { appsOfWeek, askedWeek, clampWeek, weekMinutes, weekSteps, type WeekApp } from "@/lib/week";
import { calendarWords } from "@/lib/words";
import { addDays, civilDay } from "@/lib/zone";

const APPS_SHOWN = 8;

// «16 – 22 nov», or «26 oct – 1 nov» across two months.
function rangeOf(words: Awaited<ReturnType<typeof calendarWords>>, monday: string): { from: string; to: string } {
  const sunday = addDays(monday, 6);
  return { from: monday.slice(0, 7) === sunday.slice(0, 7) ? String(words.dayOfMonth(monday)) : words.dayShort(monday), to: words.dayShort(sunday) };
}

export async function generateMetadata({ searchParams }: { searchParams: Promise<{ semana?: string }> }): Promise<Metadata> {
  const { semana } = await searchParams;
  const monday = askedWeek(semana, civilDay());
  const [words, t] = await Promise.all([calendarWords(), getTranslations("time.week")]);
  return { title: t("title", rangeOf(words, monday)) };
}

// «Semana» (RT-05). The span arrives with the week's reads, so a week past it redirects to its nearer end.
export default async function WeekPage({ searchParams }: { searchParams: Promise<{ semana?: string }> }) {
  const today = civilDay();
  const { semana } = await searchParams;
  const asked = askedWeek(semana, today);
  const sunday = addDays(asked, 6);
  const [[span, totals, byDay, claude, sites, pages, windows, sessions], words, t, tToday, tSites, tClass] = await Promise.all([
    withTimeDb((tx) => Promise.all([uploadSpan(tx), dayTotals(asked, sunday, tx), appsByDay(asked, sunday, tx), claudeBetween(asked, sunday, tx), sitesBetween(asked, sunday, tx), pagesBetween(asked, sunday, tx), editorWindowsBetween(asked, sunday, tx), claudeSessionsBetween(asked, sunday, tx)])),
    calendarWords(),
    getTranslations("time.week"),
    getTranslations("time.today"),
    getTranslations("time.internet"),
    getTranslations("time.classes"),
  ]);
  const monday = clampWeek(asked, span.firstDay, today);
  if (monday !== asked) redirect(`/semana?semana=${monday}`);
  const steps = weekSteps(monday, span.firstDay, today);
  const days = fill(monday, sunday, totals);
  const { minutes, total } = weekMinutes(days.map((one) => one.seconds));
  const longestDay = Math.max(1, ...minutes);
  const weekApps = appsOfWeek(byDay, days.map((one) => one.day), words.system);
  const apps = weekApps.map((one) => ({ app: one.app, seconds: one.total }));
  const browserKind = mainSiteClass(sites, pages);
  const classes = timeByClass(apps, sites, words.system, pages);
  const projects = projectsOf(windows);
  const screenSeconds = claude.reduce((sumOf, one) => sumOf + claudeScreen(one), 0);
  const agentSeconds = claude.reduce((sumOf, one) => sumOf + one.code, 0);
  const dayName = (day: string) => `${words.weekdayShort(day)} ${words.dayOfMonth(day)}`;
  const firstUse = span.lastReceived === null;

  // An app opens onto its seven days as small bars, each against the app's own week.
  const appRow = (one: WeekApp): BarRow => {
    const name = displayApp(one.app);
    return {
      key: one.app,
      name,
      tone: appTone(one.app, words.system, browserKind),
      figure: words.duration(one.total),
      seconds: one.total,
      label: tToday("bar", { app: name, duration: words.duration(one.total) }),
      detail: (
        <BarRows
          tone={appTone(one.app, words.system, browserKind)}
          of={one.total}
          rows={one.perDay.flatMap((seconds, index) =>
            seconds === 0 ? [] : [{ key: days[index].day, name: dayName(days[index].day), figure: words.duration(seconds), seconds, label: t("appDayBar", { app: name, day: dayName(days[index].day), duration: words.duration(seconds) }) }],
          )}
        />
      ),
    };
  };

  return (
    <Stack gap={4}>
      <Period
        title={t("title", rangeOf(words, monday))}
        summary={t("line", { duration: words.duration(total * 60) })}
        prev={steps.prev ? { href: `/semana?semana=${steps.prev}`, label: t("prev") } : undefined}
        next={steps.next ? { href: `/semana?semana=${steps.next}`, label: t("next") } : undefined}
      >
        {steps.next ? <TextLink href="/semana">{t("thisWeek")}</TextLink> : null}
      </Period>
      {firstUse ? (
        <Stack gap={2}>
          <Text as="p">{t("firstUse")}</Text>
          <TextLink button href="/llaves">{tToday("connect")}</TextLink>
        </Stack>
      ) : (
        <>
          <DayRows
            days={days.map(({ day }, index) => ({
              key: day,
              label: dayName(day),
              figure: words.duration(minutes[index] * 60),
              share: minutes[index] / longestDay,
              future: day > today,
              href: day === today ? "/" : `/dia/${day}`,
              description: day > today ? t("upcoming", { day: dayName(day) }) : t("bar", { day: dayName(day), duration: words.duration(minutes[index] * 60) }),
            }))}
          />
          {apps.length === 0 ? (
            <Text as="p">{t("empty")}</Text>
          ) : (
            <>
              <Composition label={tToday("byClassLabel")} parts={classes.map((one) => ({ key: one.kind, tone: one.kind, seconds: one.seconds, name: tClass(one.kind), figure: words.duration(one.seconds) }))} />
              <Section title={tToday("apps")}>
                <BarRows
                  of={weekApps[0]?.total}
                  rows={weekApps.slice(0, APPS_SHOWN).map(appRow)}
                  overflow={weekApps.length > APPS_SHOWN ? { summary: tToday("appsMore", { n: weekApps.length - APPS_SHOWN, duration: words.duration(sum(apps.slice(APPS_SHOWN))) }), rows: weekApps.slice(APPS_SHOWN).map(appRow) } : undefined}
                />
              </Section>
            </>
          )}
          {sites.length > 0 ? (
            <Section title={tSites("title")} figure={words.duration(sum(sites))}>
              <SiteBars sites={sites} words={words} />
            </Section>
          ) : null}
          {projects.length > 0 ? (
            <Section title={tToday("projects")} figure={words.duration(sum(projects))}>
              <ProjectBars projects={projects} words={words} />
            </Section>
          ) : null}
          <ClaudeLine screen={screenSeconds} agent={agentSeconds} sessions={sessions} hasClaudeCode={span.hasClaudeCode} words={words} />
          <Between>
            <TextLink download href={`/api/export?from=${monday}&to=${sunday}`}>
              {t("export")}
            </TextLink>
            <TextLink href="/exportar">{t("exportMore")} ›</TextLink>
          </Between>
        </>
      )}
    </Stack>
  );
}
