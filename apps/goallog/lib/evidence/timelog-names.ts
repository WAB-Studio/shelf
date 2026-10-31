// The name TimeLog shows for a process (`apps/timelog/lib/app-names.ts`), copied and not imported: an app never
// reaches into another's code (RNP-10). A commitment names an app as the person reads it there, so this must stay
// the same mapping; `timelog-apps.test.ts` pins the names a source declares.
const KNOWN: Record<string, string> = {
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

const BACKGROUND = /(updater|helper|service|host|broker)/;
const TEAMS = /^(ms-?teams|teams|microsoft\.teams.*)$/;

// «Code.exe» to «VS Code». `null` is system noise, which no commitment names.
export function readableApp(raw: string): string | null {
  const bare = raw.replace(/\.exe$/i, "");
  const key = bare.toLowerCase();
  if (SYSTEM.has(key)) return null;
  if (TEAMS.test(key)) return "Teams";
  const known = KNOWN[key];
  if (known !== undefined) return known;
  return BACKGROUND.test(key) ? null : bare;
}
