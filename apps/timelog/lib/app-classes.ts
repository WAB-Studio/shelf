import { BROWSER_NAMES } from "@/lib/app-names";
import type { AppTime, SiteTime } from "@/lib/queries";

// What an app or a site is for (RT-28). Classes describe where the time went; none of them is better than another.
export type AppClass = "code" | "ai" | "work" | "messages" | "games" | "social" | "shopping" | "system" | "other";

export const APP_CLASSES: AppClass[] = ["code", "ai", "work", "messages", "games", "social", "shopping", "system", "other"];

const CLAUDE_APP = "Claude";

const CLASS_OF: Record<string, AppClass> = {
  "VS Code": "code",
  VSCodium: "code",
  "Visual Studio": "code",
  "IntelliJ IDEA": "code",
  Terminal: "code",
  PowerShell: "code",
  Postman: "code",
  "Docker Desktop": "code",
  Unity: "code",
  "Unity Hub": "code",
  "GitHub Desktop": "code",
  Claude: "ai",
  Slack: "work",
  Teams: "work",
  Zoom: "work",
  Outlook: "work",
  WhatsApp: "messages",
  Discord: "messages",
  Telegram: "messages",
  VALORANT: "games",
  Fortnite: "games",
  "Rocket League": "games",
  Minecraft: "games",
  Steam: "games",
  "Riot Client": "games",
  "Epic Games Launcher": "games",
  Overwolf: "games",
  Spotify: "social",
  VLC: "social",
  "MPC-HC": "social",
  Explorer: "system",
};

// Games named by a pattern: any Unreal shipping build, Apex's `r5apex` builds, Fortnite's client.
const GAME_PATTERN = /(-win64-shipping|^r5apex|^fortnite)/i;

// The class of an app by its readable name; one not listed is «other». Windows' own noise is `systemName`. A browser is
// «other» here: its seconds are split by its sites in `timeByClass`.
export function appClass(name: string, systemName: string): AppClass {
  if (name === systemName) return "system";
  return CLASS_OF[name] ?? (GAME_PATTERN.test(name) ? "games" : "other");
}

// Sites by the domain a rule names; the longest matching domain wins, so «gemini.google.com» is not «google.com».
const DOMAINS: Record<string, AppClass> = {
  "github.com": "code",
  "supabase.com": "code",
  "vercel.com": "code",
  "vercel.app": "code",
  "console.cloud.google.com": "code",
  "huggingface.co": "code",
  "fal.ai": "code",
  "claude.ai": "ai",
  "chatgpt.com": "ai",
  "gemini.google.com": "ai",
  "meet.google.com": "work",
  "mail.google.com": "work",
  "docs.google.com": "work",
  "atlassian.net": "work",
  "linkedin.com": "work",
  "platform.boomi.com": "work",
  "web.whatsapp.com": "messages",
  "youtube.com": "social",
  "tiktok.com": "social",
  "facebook.com": "social",
  "instagram.com": "social",
  "x.com": "social",
  "twitter.com": "social",
  "reddit.com": "social",
  "twitch.tv": "social",
  "netflix.com": "social",
  "1688.com": "shopping",
  "homecenter.com.co": "shopping",
  "checkout.stripe.com": "shopping",
  "wompi.co": "shopping",
  "placetopay.com": "shopping",
  "ecollect.co": "shopping",
};

// Sites named by a word in one of their labels («amazon.*», «*.salesforce*»), whatever the country or suffix.
const LABELS: [RegExp, AppClass][] = [
  [/(^|\.)salesforce[a-z-]*\./, "work"],
  [/(^|\.)amazon\./, "shopping"],
  [/(^|\.)aliexpress\./, "shopping"],
  [/(^|\.)mercadolibre\./, "shopping"],
  [/(^|\.)(bancolombia|nequi|davivienda|lulo[a-z]*)\./, "shopping"],
];

// The class of a site by its host, a subdomain taking its parent's rule; one not listed is «other».
export function siteClass(host: string): AppClass {
  const bare = host.trim().toLowerCase().replace(/:\d+$/, "").replace(/^www\./, "");
  if (bare === "localhost" || bare === "127.0.0.1") return "code";
  let best: AppClass | undefined;
  let length = 0;
  for (const [domain, kind] of Object.entries(DOMAINS)) {
    if ((bare === domain || bare.endsWith(`.${domain}`)) && domain.length > length) {
      best = kind;
      length = domain.length;
    }
  }
  return best ?? LABELS.find(([pattern]) => pattern.test(bare))?.[1] ?? "other";
}

// The colour an app's row draws in: its class, except the Claude desktop app, which keeps the orange its Claude card gives it.
// A browser draws in `browserKind`, the main class of its sites.
export function appTone(name: string, systemName: string, browserKind: AppClass = "other"): AppClass | "claudeApp" {
  if (name === CLAUDE_APP) return "claudeApp";
  return BROWSER_NAMES.has(name) ? browserKind : appClass(name, systemName);
}

// The browser's seconds by class: each site's seconds under its class. Sites that outrun the browser (two devices,
// overlap) are scaled down to it; browser time no site accounts for is «other».
function browserByClass(browserSeconds: number, sites: SiteTime[]): Map<AppClass, number> {
  const perClass = new Map<AppClass, number>();
  for (const one of sites) perClass.set(siteClass(one.host), (perClass.get(siteClass(one.host)) ?? 0) + one.seconds);
  const sitesSeconds = [...perClass.values()].reduce((sum, seconds) => sum + seconds, 0);
  if (sitesSeconds > browserSeconds) {
    const scaled = new Map<AppClass, number>();
    for (const [kind, seconds] of perClass) scaled.set(kind, Math.floor((seconds * browserSeconds) / sitesSeconds));
    const largest = [...scaled].sort((a, b) => b[1] - a[1])[0];
    if (largest !== undefined) scaled.set(largest[0], largest[1] + browserSeconds - [...scaled.values()].reduce((sum, seconds) => sum + seconds, 0));
    return scaled;
  }
  perClass.set("other", (perClass.get("other") ?? 0) + browserSeconds - sitesSeconds);
  return perClass;
}

// The main class of a set of sites, the one with most seconds; «other» when there are none.
export function mainSiteClass(sites: SiteTime[]): AppClass {
  const perClass = browserByClass(Number.MAX_SAFE_INTEGER, sites);
  perClass.delete("other");
  return [...perClass].sort((a, b) => b[1] - a[1] || APP_CLASSES.indexOf(a[0]) - APP_CLASSES.indexOf(b[0]))[0]?.[0] ?? "other";
}

// The day's time by class, longest first; a class with nothing is absent. Browsers are split over the day's sites.
export function timeByClass(apps: AppTime[], sites: SiteTime[], systemName: string): { kind: AppClass; seconds: number }[] {
  const seconds = new Map<AppClass, number>();
  const add = (kind: AppClass, more: number) => seconds.set(kind, (seconds.get(kind) ?? 0) + more);
  let browser = 0;
  for (const one of apps) {
    if (BROWSER_NAMES.has(one.app)) browser += one.seconds;
    else add(appClass(one.app, systemName), one.seconds);
  }
  if (browser > 0) for (const [kind, more] of browserByClass(browser, sites)) add(kind, more);
  return [...seconds]
    .map(([kind, total]) => ({ kind, seconds: total }))
    .filter((one) => one.seconds > 0)
    .sort((a, b) => b.seconds - a.seconds || APP_CLASSES.indexOf(a.kind) - APP_CLASSES.indexOf(b.kind));
}
