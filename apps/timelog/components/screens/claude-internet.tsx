import type { ReactNode } from "react";
import { getTranslations } from "next-intl/server";

import { BarRows, capped, type BarRow } from "@/components/screens/app-rows";
import { Disclosure, Section, Text, TextLink } from "@/components/ui";
import { projectName } from "@/lib/claude-project";
import { INSTALLER_URL } from "@/lib/installer";
import { sum } from "@/lib/totals";
import type { ClaudeSessionTime, PageTime, SiteTime } from "@/lib/queries";
import type { ProjectTime } from "@/lib/vscode-project";
import type { calendarWords } from "@/lib/words";

type Words = Awaited<ReturnType<typeof calendarWords>>;

const ROWS_SHOWN = 8;
const SESSIONS_SHOWN = 8;

// Claude in one titled line (RT-24): what the person spent in front of it (claude.ai and the app; claude.ai is also a site) and what
// Claude Code worked on its own, the line opening onto Claude Code's sessions named by project. A Claude Code that never sent
// is said once, in a sentence; one that sent and did nothing leaves no line.
export async function ClaudeLine({ screen, agent, sessions, hasClaudeCode, words }: { screen: number; agent: number; sessions: ClaudeSessionTime[]; hasClaudeCode: boolean; words: Words }) {
  const t = await getTranslations("time.claude");
  const never = !hasClaudeCode && agent === 0;
  if (screen === 0 && agent === 0 && !never) return null;
  const line = screen === 0 && never ? null : never ? t("screenOnly", { screen: words.duration(screen) }) : t("screenAgent", { screen: words.duration(screen), agent: words.duration(agent) });
  const row = (one: ClaudeSessionTime): BarRow => {
    const project = projectName(one.project);
    return { key: one.session, name: project, figure: words.duration(one.seconds), seconds: one.seconds, label: t("session", { project, duration: words.duration(one.seconds) }), note: t("span", { from: words.clock(one.first), to: words.clock(one.last) }) };
  };
  const text = line === null ? null : <Text as="p">{line}</Text>;
  return (
    <Section panel title={t("title")}>
      {text === null ? null : sessions.length === 0 ? (
        text
      ) : (
        <Disclosure summary={text}>
          <BarRows tone="claude" of={Math.max(agent, ...sessions.map((one) => one.seconds))} {...capped(sessions, SESSIONS_SHOWN, row, (rest) => t("sessionsMore", { n: rest.length }))} />
        </Disclosure>
      )}
      {never ? <Text as="p" variant="meta">{t("never")}</Text> : null}
    </Section>
  );
}

// The longest projects as bars (RT-23), «y N más · X» opening onto the rest: a day's card and a week's are this.
export async function ProjectBars({ projects, words }: { projects: ProjectTime[]; words: Words }) {
  const t = await getTranslations("time.today");
  const row = (one: ProjectTime): BarRow => ({ key: one.project, name: one.project, figure: words.duration(one.seconds), seconds: one.seconds, label: t("projectBar", { project: one.project, duration: words.duration(one.seconds) }) });
  return <BarRows aligned of={projects[0]?.seconds} {...capped(projects, ROWS_SHOWN, row, (rest) => t("projectsMore", { n: rest.length, duration: words.duration(sum(rest)) }))} />;
}

// The longest hostnames as bars (RT-13), «y N más · X» opening onto the rest; `detail` opens a site onto what it holds.
export async function SiteBars({ sites, words, detail }: { sites: SiteTime[]; words: Words; detail?: (host: string) => ReactNode }) {
  const t = await getTranslations("time.internet");
  const row = (one: SiteTime): BarRow => ({ key: one.host, name: one.host, figure: words.duration(one.seconds), seconds: one.seconds, label: t("bar", { host: one.host, duration: words.duration(one.seconds) }), detail: detail?.(one.host) });
  return <BarRows aligned of={sites[0]?.seconds} {...capped(sites, ROWS_SHOWN, row, (rest) => t("more", { n: rest.length, duration: words.duration(sum(rest)) }))} />;
}

// «Sitios» of one day (RT-13): the longest hostnames, each opening onto its pages.
export async function SitesBlock({ isToday, sites, pages, hasSites, words }: { isToday: boolean; sites: SiteTime[]; pages: PageTime[]; hasSites: boolean; words: Words }) {
  const t = await getTranslations("time.internet");
  const pageRow = (page: PageTime): BarRow => {
    const name = page.title === "" ? page.url : page.title;
    return { key: `${page.url}\n${page.title}`, name, figure: words.duration(page.seconds), seconds: page.seconds, wrap: true, label: t("pageBar", { title: name, duration: words.duration(page.seconds) }), note: page.url };
  };
  // A site opens onto its longest pages: the title, and the address under it.
  const pagesOf = (host: string) => {
    const mine = pages.filter((page) => page.host === host);
    const of = sites.find((one) => one.host === host)?.seconds;
    return (
      <BarRows
        of={of}
        rows={mine.slice(0, ROWS_SHOWN).map(pageRow)}
        overflow={mine.length > ROWS_SHOWN ? { summary: t("pagesMore", { n: mine.length - ROWS_SHOWN }), rows: mine.slice(ROWS_SHOWN).map(pageRow) } : undefined}
      />
    );
  };
  const detail = (host: string) => (pages.some((page) => page.host === host) ? pagesOf(host) : undefined);
  return (
    <Section panel title={t("title")} figure={sites.length > 0 ? words.duration(sum(sites)) : undefined}>
      {sites.length > 0 ? (
        <>
          <SiteBars sites={sites} words={words} detail={detail} />
          <Text as="p" variant="meta">{t("privacy")}</Text>
        </>
      ) : (
        <>
          <Text as="p" variant="meta">{t(hasSites ? (isToday ? "emptyToday" : "empty") : "never")}</Text>
          {hasSites ? null : (
            <TextLink href={INSTALLER_URL} target="_blank" rel="noreferrer">
              {t("install")} ›
            </TextLink>
          )}
        </>
      )}
    </Section>
  );
}
