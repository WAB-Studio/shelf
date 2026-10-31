import { getTranslations } from "next-intl/server";

import { BarRows, type BarRow } from "@/components/screens/app-rows";
import { Disclosure, Stack, Text, TextLink } from "@/components/ui";
import { claudeSources, claudeTotal, sourcesOverlap } from "@/lib/daily";
import { projectName } from "@/lib/claude-project";
import type { ClaudeDay, ClaudeSessionTime, PageTime, SiteTime } from "@/lib/queries";
import type { calendarWords } from "@/lib/words";

type Words = Awaited<ReturnType<typeof calendarWords>>;

const SITES_SHOWN = 8;
const PAGES_SHOWN = 8;
const SESSIONS_SHOWN = 8;
// ActivityWatch's page on the browser extension that records the tab in front.
const EXTENSION_URL = "https://docs.activitywatch.net/en/latest/watchers.html#web-watchers";

// «Claude» of one day (RT-14): Claude Code, claude.ai and the desktop app, and what they add up to. A row shows once
// its source has ever sent anything, so a PC with no Claude folder is told so rather than shown a flat zero.
export async function ClaudeBlock({ isToday, claude, sessions, hasClaudeCode, hasSites, words }: { isToday: boolean; claude: ClaudeDay | undefined; sessions: ClaudeSessionTime[]; hasClaudeCode: boolean; hasSites: boolean; words: Words }) {
  const t = await getTranslations("time.claude");
  const parts = claude ?? { day: "", code: 0, web: 0, desktop: 0 };
  const total = claudeTotal(parts);
  const sources = claudeSources(parts, { code: t("code"), web: t("web"), desktop: t("desktop") });
  const shown = { code: hasClaudeCode, web: hasSites, desktop: false };
  const rows = sources.filter((row) => shown[row.key] || row.seconds > 0);

  return (
    <Stack gap={2}>
      {total === 0 ? (
        <Text as="p" variant="meta">{t(hasClaudeCode ? (isToday ? "emptyToday" : "empty") : "never")}</Text>
      ) : (
        <>
          <BarRows of={total} rows={rows.map((row) => ({ key: row.key, tone: row.tone, name: row.name, figure: words.duration(row.seconds), seconds: row.seconds, label: t("bar", { name: row.name, duration: words.duration(row.seconds) }) }))} />
          {sourcesOverlap(rows) ? <Text as="p" variant="meta">{t("overlap")}</Text> : null}
        </>
      )}
      {sessions.length > 0 ? (
        <Stack gap={2}>
          <Text variant="meta">{t("sessions")}</Text>
          <BarRows
            tone="claude"
            of={Math.max(parts.code, ...sessions.map((one) => one.seconds))}
            rows={sessions.slice(0, SESSIONS_SHOWN).map((one) => {
              const project = projectName(one.project);
              return {
                key: one.session,
                name: project,
                figure: words.duration(one.seconds),
                seconds: one.seconds,
                label: t("session", { project, duration: words.duration(one.seconds) }),
                note: t("span", { from: words.clock(one.first), to: words.clock(one.last) }),
              };
            })}
          />
        </Stack>
      ) : null}
    </Stack>
  );
}

// «Internet» of one day (RT-13): the longest hostnames, never a page.
export async function InternetBlock({ isToday, sites, pages, hasSites, words }: { isToday: boolean; sites: SiteTime[]; pages: PageTime[]; hasSites: boolean; words: Words }) {
  const t = await getTranslations("time.internet");
  const pageRow = (page: PageTime): BarRow => {
    const name = page.title === "" ? page.url : page.title;
    return { key: `${page.url}\n${page.title}`, name, figure: words.duration(page.seconds), seconds: page.seconds, label: t("pageBar", { title: name, duration: words.duration(page.seconds) }), note: page.url };
  };
  // A site opens onto its longest pages: the title, and the address under it.
  const pagesOf = (host: string) => {
    const mine = pages.filter((page) => page.host === host);
    const of = sites.find((one) => one.host === host)?.seconds;
    return (
      <>
        <BarRows tone="browser" of={of} rows={mine.slice(0, PAGES_SHOWN).map(pageRow)} />
        {mine.length > PAGES_SHOWN ? (
          <Disclosure summary={<Text variant="meta">{t("pagesMore", { n: mine.length - PAGES_SHOWN })}</Text>}>
            <BarRows tone="browser" of={of} rows={mine.slice(PAGES_SHOWN).map(pageRow)} />
          </Disclosure>
        ) : null}
      </>
    );
  };
  const siteRow = (one: SiteTime): BarRow => ({ key: one.host, name: one.host, figure: words.duration(one.seconds), seconds: one.seconds, label: t("bar", { host: one.host, duration: words.duration(one.seconds) }), detail: pages.some((page) => page.host === one.host) ? pagesOf(one.host) : undefined });
  return (
    <Stack gap={2}>
      {sites.length > 0 ? (
        <>
          <BarRows tone="browser" of={sites[0].seconds} rows={sites.slice(0, SITES_SHOWN).map(siteRow)} />
          {sites.length > SITES_SHOWN ? (
            <Disclosure summary={<Text variant="meta">{t("more", { n: sites.length - SITES_SHOWN })}</Text>}>
              <BarRows tone="browser" of={sites[0].seconds} rows={sites.slice(SITES_SHOWN).map(siteRow)} />
            </Disclosure>
          ) : null}
          <Text as="p" variant="meta">{t("privacy")}</Text>
        </>
      ) : (
        <>
          <Text as="p" variant="meta">{t(hasSites ? (isToday ? "emptyToday" : "empty") : "never")}</Text>
          {hasSites ? null : (
            <TextLink href={EXTENSION_URL} target="_blank" rel="noreferrer">
              {t("install")} ›
            </TextLink>
          )}
        </>
      )}
    </Stack>
  );
}
