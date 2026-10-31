import { getTranslations } from "next-intl/server";

import { BarRows, type BarRow } from "@/components/screens/app-rows";
import { AutoRefresh } from "@/components/screens/auto-refresh";
import { ClaudeBlock, InternetBlock } from "@/components/screens/claude-internet";
import { Timeline } from "@/components/ui/timeline";
import { Card, Cards, Composition, DayStrip, Disclosure, Figure, Hero, HeroColumns, Mosaic, Stack, Text, TextLink, Tile, Title } from "@/components/ui";
import { appClass, timeByClass } from "@/lib/app-classes";
import { readableApp } from "@/lib/app-names";
import { projectName } from "@/lib/claude-project";
import { claudeTotal } from "@/lib/daily";
import type { AppTime } from "@/lib/queries";
import { appsBetween, claudeBetween, claudeSessionsBetween, dayTotals, devicesBetween, pagesBetween, sitesBetween, uploadSpan, windowsBetween } from "@/lib/queries";
import { focusShare, hourMarks, layoutSessions, minuteOfDay } from "@/lib/timeline";
import { percent, sum } from "@/lib/totals";
import { calendarWords } from "@/lib/words";
import { dayStrip } from "@/lib/week";
import { addDays, civilDay } from "@/lib/zone";

const TITLES_SHOWN = 8;
const APPS_SHOWN = 8;

// One day (RT-04, RT-11): the total in the brand block, the top app and, on a past day, the gap to the day before, then the apps.
// «Hoy» is this screen for today; any past day opens on `/dia/AAAA-MM-DD`.
export async function DayView({ day }: { day: string }) {
  const today = civilDay();
  const isToday = day === today;
  const before = addDays(day, -1);
  const [raw, sites, pages, windows, sessions, claudeDays, previous, devices, span, words, t, tClaude, tInternet, tTimeline, tClass, tAll] = await Promise.all([
    appsBetween(day, day),
    sitesBetween(day, day),
    pagesBetween(day, day),
    windowsBetween(day, day),
    claudeSessionsBetween(day, day),
    claudeBetween(day, day),
    // Only a whole day compares: uploads carry day totals, so today so far has no like-for-like yesterday.
    isToday ? Promise.resolve([]) : dayTotals(before, before),
    devicesBetween(day, day),
    uploadSpan(),
    calendarWords(),
    getTranslations("time.today"),
    getTranslations("time.claude"),
    getTranslations("time.internet"),
    getTranslations("time.timeline"),
    getTranslations("time.classes"),
    getTranslations("time"),
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
  const claudeParts = [
    { key: "code", tone: "claude" as const, seconds: claude?.code ?? 0, name: tClaude("code"), figure: words.duration(claude?.code ?? 0) },
    { key: "web", tone: "claudeWeb" as const, seconds: claude?.web ?? 0, name: tClaude("web"), figure: words.duration(claude?.web ?? 0) },
    { key: "desktop", tone: "claudeApp" as const, seconds: claude?.desktop ?? 0, name: tClaude("desktop"), figure: words.duration(claude?.desktop ?? 0) },
  ];
  const claudeLabel = claudeParts.filter((one) => one.seconds > 0).map((one) => `${one.name}: ${one.figure}`).join(", ");
  const total = sum(apps);
  const top = apps[0];
  const tSystem = tAll("system");
  const classes = timeByClass(apps, tSystem);
  const previousTotal = previous[0]?.seconds ?? 0;
  const delta = total - previousTotal;
  const date = t("title", { weekday: words.weekday(day), day: words.dayOfMonth(day), month: words.month(day) });
  const strip = dayStrip(day, span.firstDay, today);
  const hrefOf = (target: string) => (target === today ? "/" : `/dia/${target}`);

  // Before the first upload there is nothing to read: no empty sections stand in for it.
  const firstUse = top === undefined && span.lastReceived === null;

  // An app's row opens onto its longest windows, each measured against the app's own time.
  const appRow = (one: AppTime): BarRow => {
    const tone = appClass(one.app, tSystem);
    const mine = titlesOf.get(one.app) ?? [];
    return {
      key: one.app,
      name: one.app,
      tone,
      figure: words.duration(one.seconds),
      seconds: one.seconds,
      label: t("bar", { app: one.app, duration: words.duration(one.seconds) }),
      detail:
        mine.length === 0 ? undefined : (
          <>
            <BarRows
              tone={tone}
              of={one.seconds}
              rows={mine.slice(0, TITLES_SHOWN).map((title) => ({
                key: title.app + title.title,
                name: title.title,
                figure: words.duration(title.seconds),
                seconds: title.seconds,
                label: t("windowBar", { title: title.title, duration: words.duration(title.seconds) }),
              }))}
            />
            {mine.length > TITLES_SHOWN ? <Text as="p" variant="meta">{t("windowsMore", { n: mine.length - TITLES_SHOWN })}</Text> : null}
          </>
        ),
    };
  };

  // Claude Code's sessions are all that carries a time of day: they lay along the day, which opens at the hour now.
  const line = layoutSessions(sessions.map((one) => ({ key: one.session, label: projectName(one.project), first: one.first, last: one.last })));
  const clockOf = (minute: number) => words.clock(new Date(Date.UTC(2026, 0, 1, Math.floor(minute / 60) + 5, minute % 60)));

  return (
    <Stack gap={4}>
      {isToday ? <AutoRefresh /> : null}
      <DayStrip
        label={`${words.dayShort(strip.monday)} – ${words.dayShort(addDays(strip.monday, 6))}`}
        weekPrev={strip.prev === null ? undefined : { href: hrefOf(strip.prev), label: t("stripPrev") }}
        dayPrev={span.firstDay !== null && day > span.firstDay ? { href: hrefOf(before), label: t("stripDayPrev") } : undefined}
        dayNext={day < today ? { href: hrefOf(addDays(day, 1)), label: t("stripDayNext") } : undefined}
        weekNext={strip.next === null ? undefined : { href: hrefOf(strip.next), label: t("stripNext") }}
        days={strip.days.map((one) => ({
          key: one.day,
          initial: words.weekdayInitial(one.day),
          number: words.dayOfMonth(one.day),
          current: one.current,
          href: one.reachable ? hrefOf(one.day) : undefined,
          description: t("stripDay", { weekday: words.weekday(one.day), day: words.dayOfMonth(one.day), month: words.month(one.day) }),
        }))}
      />
      <Hero>
        {top !== undefined ? (
          <Stack gap={4}>
          <HeroColumns>
            <Stack gap={3}>
              <Title small>{date}</Title>
              <Stack gap={2}>
                <Text variant="meta">{t(isToday ? "total" : "totalPast")}</Text>
                <Figure parts={words.durationParts(total)} mark />
                {devices.length > 1 ? (
                  <Stack gap={1}>
                    <Text variant="meta">{t("devicesSum", { n: devices.length })}</Text>
                    {devices.map((one) => (
                      <Text key={one.device} variant="meta" truncate>{one.device} · {words.duration(one.seconds)}</Text>
                    ))}
                  </Stack>
                ) : null}
                {isToday && span.lastReceived !== null ? <Text variant="meta">{t("updated", { ago: words.ago(span.lastReceived) })}</Text> : null}
              </Stack>
            </Stack>
            <Stack gap={4}>
              <Stack gap={2}>
                <Text variant="meta">{t("claudeCard")}</Text>
                <Text as="p">{claudeSeconds > 0 ? t("claudeGlance", { duration: words.duration(claudeSeconds), percent: percent(claudeSeconds, total) }) : t("claudeNoneDay")}</Text>
                {claudeSeconds > 0 ? (
                  <Composition
                    thin
                    label={claudeLabel}
                    parts={claudeParts.filter((one) => one.seconds > 0)}
                  />
                ) : null}
              </Stack>
              <Stack gap={2}>
              <Text variant="meta">{t("byClass")}</Text>
              <Composition
                label={t("byClassLabel")}
                parts={classes.map((one) => ({ key: one.kind, tone: one.kind, seconds: one.seconds, name: tClass(one.kind), figure: words.duration(one.seconds) }))}
              />
              </Stack>
            </Stack>
          </HeroColumns>
          <Cards>
            <Card label={t("topApp")}>
              <Text truncate>{top.app}</Text>
              <Text mono>{words.duration(top.seconds)}</Text>
            </Card>
            {!isToday && previousTotal > 0 ? (
              <Card label={t("versus")}>
                <Text mono>{delta === 0 ? t("versusSame") : t(delta > 0 ? "versusMore" : "versusLess", { duration: words.duration(Math.abs(delta)) })}</Text>
              </Card>
            ) : null}
          </Cards>
          </Stack>
        ) : (
          <Stack gap={3}>
            <Title small>{date}</Title>
            <Stack gap={2}>
              <Text as="p">{span.lastReceived === null ? t("never") : t(isToday ? "empty" : "emptyPast")}</Text>
              {span.lastReceived === null ? null : <Text as="p" variant="meta">{t(isToday ? "emptyWhy" : "emptyPastWhy")}</Text>}
              {span.lastReceived === null ? null : <Text as="p" variant="meta">{t("lastUpload", { when: words.moment(span.lastReceived) })}</Text>}
            </Stack>
          </Stack>
        )}
      </Hero>
      {line.segments.length > 0 ? (
        <Tile full title={tTimeline("title")}>
          <Timeline
            label={tTimeline("label")}
            lanes={line.lanes}
            focus={focusShare(line, isToday ? minuteOfDay(new Date()) : null)}
            marks={hourMarks(line.startHour).map((mark) => ({ key: String(mark.hour), label: `${mark.hour % 24}:00`, left: mark.left }))}
            segments={line.segments.map((one) => ({ key: one.key, label: one.label, left: one.left, width: one.width, lane: one.lane, description: tTimeline("session", { project: one.label, from: clockOf(one.from), to: clockOf(one.to) }) }))}
          />
        </Tile>
      ) : null}
      {firstUse ? <TextLink button href="/llaves">{t("connect")}</TextLink> : null}
      {firstUse ? null : (
        <Mosaic>
          {apps.length > 0 ? (
            <Tile lead title={t("apps")} figure={words.duration(total)}>
              <BarRows of={top?.seconds} rows={apps.slice(0, APPS_SHOWN).map(appRow)} />
              {apps.length > APPS_SHOWN ? (
                <Disclosure summary={<Text variant="meta">{t("appsMore", { n: apps.length - APPS_SHOWN, duration: words.duration(sum(apps.slice(APPS_SHOWN))) })}</Text>}>
                  <BarRows of={top?.seconds} rows={apps.slice(APPS_SHOWN).map(appRow)} />
                </Disclosure>
              ) : null}
            </Tile>
          ) : null}
          <Tile title={tClaude("title")} figure={claudeSeconds > 0 ? words.duration(claudeSeconds) : "—"}>
            <ClaudeBlock claude={claude} sessions={sessions} hasClaudeCode={span.hasClaudeCode} hasSites={span.hasSites} words={words} />
          </Tile>
          <Tile title={tInternet("title")} figure={sites.length > 0 ? words.duration(sum(sites)) : "—"}>
            <InternetBlock sites={sites} pages={pages} hasSites={span.hasSites} words={words} />
          </Tile>
        </Mosaic>
      )}
    </Stack>
  );
}
