import { getTranslations } from "next-intl/server";

import { BarRows, type BarRow } from "@/components/screens/app-rows";
import { AutoRefresh } from "@/components/screens/auto-refresh";
import { ClaudeLine, ProjectBars, SitesBlock } from "@/components/screens/claude-internet";
import { Columns, Composition, Period, Section, Stack, Text, TextLink } from "@/components/ui";
import { appTone, mainSiteClass, timeByClass } from "@/lib/app-classes";
import { displayApp, readableApp } from "@/lib/app-names";
import { claudeScreen } from "@/lib/daily";
import type { AppTime } from "@/lib/queries";
import { appsBetween, claudeBetween, claudeSessionsBetween, devicesBetween, pagesBetween, sitesBetween, uploadSpan, windowsBetween } from "@/lib/queries";
import { withTimeDb } from "@/lib/session";
import { sum } from "@/lib/totals";
import { projectsOf } from "@/lib/vscode-project";
import { calendarWords } from "@/lib/words";
import { addDays, civilDay } from "@/lib/zone";

const TITLES_SHOWN = 8;
const APPS_SHOWN = 8;

// One day (RT-04, RT-11, RT-34): its name and total with ‹ › a day away, the day split by class, then the apps in the wide
// column and the sites, the projects and Claude beside them. «Hoy» is this screen for today; any past day opens on `/dia/AAAA-MM-DD`.
export async function DayView({ day }: { day: string }) {
  const today = civilDay();
  const isToday = day === today;
  // One settled transaction for every read: they pipeline on its connection, one pool slot and one settle for the screen.
  const [reads, words, t, tClass] = await Promise.all([
    withTimeDb((tx) =>
      Promise.all([
        appsBetween(day, day, tx),
        sitesBetween(day, day, tx),
        pagesBetween(day, day, tx),
        windowsBetween(day, day, tx),
        claudeSessionsBetween(day, day, tx),
        claudeBetween(day, day, tx),
        devicesBetween(day, day, tx),
        uploadSpan(tx),
      ]),
    ),
    calendarWords(),
    getTranslations("time.today"),
    getTranslations("time.classes"),
  ]);
  const [raw, sites, pages, windows, sessions, claudeDays, devices, span] = reads;
  const claude = claudeDays[0];
  const apps = words.apps(raw);
  // Windows come under the readable name of their app, two processes with one name together.
  const titlesOf = new Map<string, typeof windows>();
  for (const one of windows) {
    const name = readableApp(one.app);
    if (name !== null) titlesOf.set(name, [...(titlesOf.get(name) ?? []), one]);
  }
  const projects = projectsOf(windows);
  const total = sum(apps);
  const tSystem = words.system;
  const browserKind = mainSiteClass(sites, pages);
  const classes = timeByClass(apps, sites, tSystem, pages);
  const date = t("title", { weekday: words.weekday(day), date: words.dayShort(day) });
  const hrefOf = (target: string) => (target === today ? "/" : `/dia/${target}`);

  // Before the first upload there is nothing to read: no empty sections stand in for it.
  const firstUse = apps.length === 0 && span.lastReceived === null;
  // A past day nothing arrived on has nothing to open.
  const emptyPast = !isToday && apps.length === 0 && sites.length === 0;

  const windowRow = (title: (typeof windows)[number]): BarRow => ({
    key: title.app + title.title,
    name: title.title,
    figure: words.duration(title.seconds),
    seconds: title.seconds,
    wrap: true,
    label: t("windowBar", { title: title.title, duration: words.duration(title.seconds) }),
  });

  // An app's row opens onto its longest windows, each measured against the app's own time.
  const appRow = (one: AppTime): BarRow => {
    const tone = appTone(one.app, tSystem, browserKind);
    const mine = titlesOf.get(one.app) ?? [];
    const name = displayApp(one.app);
    return {
      key: one.app,
      name,
      tone,
      figure: words.duration(one.seconds),
      seconds: one.seconds,
      label: t("bar", { app: name, duration: words.duration(one.seconds) }),
      detail:
        mine.length === 0 ? undefined : (
          <BarRows
            tone={tone}
            of={one.seconds}
            rows={mine.slice(0, TITLES_SHOWN).map(windowRow)}
            overflow={mine.length > TITLES_SHOWN ? { summary: t("windowsMore", { n: mine.length - TITLES_SHOWN }), rows: mine.slice(TITLES_SHOWN).map(windowRow) } : undefined}
          />
        ),
    };
  };

  return (
    <Stack gap={4}>
      {isToday ? <AutoRefresh /> : null}
      <Period
        title={date}
        summary={apps.length > 0 ? t("line", { duration: words.duration(total) }) : undefined}
        prev={span.firstDay !== null && day > span.firstDay ? { href: hrefOf(addDays(day, -1)), label: t("prevDay") } : undefined}
        next={day < today ? { href: hrefOf(addDays(day, 1)), label: t("nextDay") } : undefined}
      >
        {isToday ? null : <TextLink href="/">{t("toToday")}</TextLink>}
        {isToday && span.lastReceived !== null ? <Text variant="meta">{t("updated", { ago: words.ago(span.lastReceived) })}</Text> : null}
        {devices.length > 1 ? <Text variant="meta">{t("devices", { n: devices.length, list: devices.map((one) => `${one.device} ${words.duration(one.seconds)}`).join(", ") })}</Text> : null}
      </Period>
      {apps.length === 0 ? (
        <Stack gap={2}>
          <Text as="p">{span.lastReceived === null ? t("never") : t(isToday ? "empty" : "emptyPast")}</Text>
          {span.lastReceived === null ? null : <Text as="p" variant="meta">{t(isToday ? "emptyWhy" : "emptyPastWhy")}</Text>}
          {span.lastReceived === null || !isToday ? null : <Text as="p" variant="meta">{t("lastUpload", { when: words.moment(span.lastReceived) })}</Text>}
        </Stack>
      ) : (
        <Composition label={t("byClassLabel")} parts={classes.map((one) => ({ key: one.kind, tone: one.kind, seconds: one.seconds, name: tClass(one.kind), figure: words.duration(one.seconds) }))} />
      )}
      {firstUse ? <TextLink button href="/llaves">{t("connect")}</TextLink> : null}
      {firstUse || emptyPast ? null : (
        <Columns
          main={
            apps.length > 0 ? (
              <Section panel title={t("apps")} figure={words.duration(total)}>
                <BarRows
                  of={apps[0]?.seconds}
                  rows={apps.slice(0, APPS_SHOWN).map(appRow)}
                  overflow={apps.length > APPS_SHOWN ? { summary: t("appsMore", { n: apps.length - APPS_SHOWN, duration: words.duration(sum(apps.slice(APPS_SHOWN))) }), rows: apps.slice(APPS_SHOWN).map(appRow) } : undefined}
                />
              </Section>
            ) : null
          }
          aside={
            <>
              <SitesBlock isToday={isToday} sites={sites} pages={pages} hasSites={span.hasSites} words={words} />
              {projects.length > 0 ? (
                <Section panel title={t("projects")} figure={words.duration(sum(projects))}>
                  <ProjectBars projects={projects} words={words} />
                </Section>
              ) : null}
              <ClaudeLine screen={claude === undefined ? 0 : claudeScreen(claude)} agent={claude?.code ?? 0} sessions={sessions} hasClaudeCode={span.hasClaudeCode} words={words} />
            </>
          }
        />
      )}
    </Stack>
  );
}
