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
  steamwebhelper: "Steam",
  riotclientservices: "Riot Client",
  "whatsapp.root": "WhatsApp",
  idea64: "IntelliJ IDEA",
  vlc: "VLC",
  "mpc-hc64": "MPC-HC",
  "powertoys.powerlauncher": "PowerToys",
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
  "svchost",
  "conhost",
  "dllhost",
  "sihost",
  "taskhost",
  "taskhostw",
  "nvsphelper64",
]);

// Updaters, helpers, services, hosts and brokers: background processes nobody opened. Whole words only, split at
// punctuation and at a capital after a lower-case letter: «RuntimeBroker» is one, «GhostOfTsushima» is none.
const BACKGROUND = new Set(["updater", "helper", "service", "host", "broker"]);

// A lower-case compound that ends in one of these is a host or helper of something («nvsphelper64», «wudfhost»);
// three letters ahead of «host» keep «ghost» out. Games are named in capitals or by a known name, never this way.
const COMPOUND = /^[a-z0-9]{3,}(host|helper|svc)\d*$/;

function isBackground(bare: string): boolean {
  if (COMPOUND.test(bare)) return true;
  return bare
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .some((word) => BACKGROUND.has(word));
}

const TEAMS = /^(ms-?teams|teams|microsoft\.teams.*)$/;

// «Code.exe» to «VS Code»; a process not known keeps its name without the extension. `null` is system noise.
export function readableApp(raw: string): string | null {
  const bare = raw.replace(/\.exe$/i, "");
  const key = bare.toLowerCase();
  if (SYSTEM.has(key)) return null;
  if (TEAMS.test(key)) return "Teams";
  const known = KNOWN[key];
  if (known !== undefined) return known;
  return isBackground(bare) ? null : bare;
}

// The name a row of raw process names is counted under: its readable name, or `systemName` for Windows' noise.
export function appName(raw: string, systemName: string): string {
  return readableApp(raw) ?? systemName;
}

// The day's apps under their readable names: two processes with one name add up, system noise becomes
// one row named `systemName`. Longest first, then by name, as the query returns them.
export function readableApps(apps: AppTime[], systemName: string): AppTime[] {
  const seconds = new Map<string, number>();
  for (const one of apps) {
    const name = appName(one.app, systemName);
    seconds.set(name, (seconds.get(name) ?? 0) + one.seconds);
  }
  return [...seconds].map(([app, total]) => ({ app, seconds: total })).sort((a, b) => b.seconds - a.seconds || a.app.localeCompare(b.app));
}
