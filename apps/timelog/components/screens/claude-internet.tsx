import { getTranslations } from "next-intl/server";

import { BarRows } from "@/components/screens/app-rows";
import { Between, Stack, Text, TextLink } from "@/components/ui";
import { claudeTotal } from "@/lib/daily";
import type { ClaudeDay, SiteTime } from "@/lib/queries";
import type { calendarWords } from "@/lib/words";

type Words = Awaited<ReturnType<typeof calendarWords>>;

const SITES_SHOWN = 8;
// ActivityWatch's page on the browser extension that records the tab in front.
const EXTENSION_URL = "https://docs.activitywatch.net/en/latest/watchers.html#web-watchers";

// «Claude» of one day (RT-14): Claude Code, claude.ai and the desktop app, and what they add up to. A row shows once
// its source has ever sent anything, so a PC with no Claude folder is told so rather than shown a flat zero.
export async function ClaudeBlock({ claude, hasClaudeCode, hasSites, words }: { claude: ClaudeDay | undefined; hasClaudeCode: boolean; hasSites: boolean; words: Words }) {
  const t = await getTranslations("time.claude");
  const parts = claude ?? { day: "", code: 0, web: 0, desktop: 0 };
  const total = claudeTotal(parts);
  const rows = [
    { key: "code", name: t("code"), seconds: parts.code, shown: hasClaudeCode || parts.code > 0 },
    { key: "web", name: t("web"), seconds: parts.web, shown: hasSites || parts.web > 0 },
    { key: "desktop", name: t("desktop"), seconds: parts.desktop, shown: parts.desktop > 0 },
  ].filter((row) => row.shown);

  return (
    <Stack gap={2}>
      <Between>
        <Text variant="meta">{t("total")}</Text>
        <Text mono>{total > 0 ? words.duration(total) : "—"}</Text>
      </Between>
      {total === 0 ? (
        <Text as="p" variant="meta">{t(hasClaudeCode ? "empty" : "never")}</Text>
      ) : (
        <>
          <BarRows rows={rows.map((row) => ({ key: row.key, name: row.name, figure: words.duration(row.seconds), seconds: row.seconds, label: t("bar", { name: row.name, duration: words.duration(row.seconds) }) }))} />
          <Text as="p" variant="meta">{t("overlap")}</Text>
        </>
      )}
    </Stack>
  );
}

// «Internet» of one day (RT-13): the longest hostnames, never a page.
export async function InternetBlock({ sites, hasSites, words }: { sites: SiteTime[]; hasSites: boolean; words: Words }) {
  const t = await getTranslations("time.internet");
  const shown = sites.slice(0, SITES_SHOWN);
  return (
    <Stack gap={2}>
      <Text variant="meta">{t("title")}</Text>
      {shown.length > 0 ? (
        <>
          <BarRows rows={shown.map((one) => ({ key: one.host, name: one.host, figure: words.duration(one.seconds), seconds: one.seconds, label: t("bar", { host: one.host, duration: words.duration(one.seconds) }) }))} />
          {sites.length > shown.length ? <Text as="p" variant="meta">{t("more", { n: sites.length - shown.length })}</Text> : null}
          <Text as="p" variant="meta">{t("privacy")}</Text>
        </>
      ) : (
        <>
          <Text as="p" variant="meta">{t(hasSites ? "empty" : "never")}</Text>
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
