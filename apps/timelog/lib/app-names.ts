import type { AppTime } from "@/lib/queries";

// Well-known processes by their lower-cased name without «.exe».
const KNOWN: Record<string, string> = {
  claude: "Claude",
  code: "VS Code",
  devenv: "Visual Studio",
  msedge: "Edge",
  chrome: "Chrome",
  firefox: "Firefox",
  brave: "Brave",
  windowsterminal: "Terminal",
  explorer: "Explorer",
  notepad: "Notepad",
  winword: "Word",
  excel: "Excel",
  powerpnt: "PowerPoint",
  outlook: "Outlook",
  slack: "Slack",
  discord: "Discord",
  spotify: "Spotify",
  figma: "Figma",
  zoom: "Zoom",
  steam: "Steam",
  obs64: "OBS",
  whatsapp: "WhatsApp",
  javaw: "Java",
  java: "Java",
};

// Windows' own background hosts: noise on a day's list, kept together.
const SYSTEM = new Set([
  "lockapp",
  "searchhost",
  "searchapp",
  "msedgewebview2",
  "shellexperiencehost",
  "startmenuexperiencehost",
  "applicationframehost",
  "systemsettings",
  "textinputhost",
  "logonui",
  "shellhost",
  "dwm",
  "taskmgr",
  "widgets",
  "openconsole",
]);

// Updaters, helpers, services, hosts and brokers: background processes nobody opened.
const BACKGROUND = /(updater|helper|service|host|broker)/;

const TEAMS = /^(ms-?teams|teams|microsoft\.teams.*)$/;

// «Code.exe» to «VS Code»; a process not known keeps its name without the extension. `null` is system noise.
export function readableApp(raw: string): string | null {
  const bare = raw.replace(/\.exe$/i, "");
  const key = bare.toLowerCase();
  if (SYSTEM.has(key)) return null;
  if (TEAMS.test(key)) return "Teams";
  const known = KNOWN[key];
  if (known !== undefined) return known;
  return BACKGROUND.test(key) ? null : bare;
}

// The day's apps under their readable names: two processes with one name add up, system noise becomes
// one row named `systemName`. Longest first, then by name, as the query returns them.
export function readableApps(apps: AppTime[], systemName: string): AppTime[] {
  const seconds = new Map<string, number>();
  for (const one of apps) {
    const name = readableApp(one.app) ?? systemName;
    seconds.set(name, (seconds.get(name) ?? 0) + one.seconds);
  }
  return [...seconds].map(([app, total]) => ({ app, seconds: total })).sort((a, b) => b.seconds - a.seconds || a.app.localeCompare(b.app));
}
