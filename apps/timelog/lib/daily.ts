import { readableApps } from "@/lib/app-names";
import type { ClaudeDay, DayApp, DayTotal } from "@/lib/queries";
import { addDays } from "@/lib/zone";

export const MAX_EXPORT_DAYS = 366;

// A day of the export (RT-15): the same row in the CSV and in the MCP tool.
export type DailyRow = {
  day: string;
  total_seconds: number;
  claude_code_seconds: number;
  claude_ai_seconds: number;
  claude_desktop_seconds: number;
  claude_seconds: number;
  top_app: string;
  top_app_seconds: number;
  // 1 when the PC uploaded that day, 0 when nothing arrived: a day of zeros is then a day unseen, not a real zero.
  uploaded: number;
};

export type ClaudeSource = { key: "code" | "web" | "desktop"; tone: "claude" | "claudeWeb" | "claudeApp"; name: string; seconds: number };

// Claude Code, claude.ai and the desktop app of a day, in that order, each under its name.
export function claudeSources(claude: Pick<ClaudeDay, "code" | "web" | "desktop"> | undefined, names: { code: string; web: string; desktop: string }): ClaudeSource[] {
  return [
    { key: "code", tone: "claude", name: names.code, seconds: claude?.code ?? 0 },
    { key: "web", tone: "claudeWeb", name: names.web, seconds: claude?.web ?? 0 },
    { key: "desktop", tone: "claudeApp", name: names.desktop, seconds: claude?.desktop ?? 0 },
  ];
}

// Two sources with time at once are both counted, which is what the note under them says.
export const sourcesOverlap = (sources: ClaudeSource[]) => sources.filter((one) => one.seconds > 0).length >= 2;

export const claudeTotal = (one: Pick<ClaudeDay, "code" | "web" | "desktop">) => one.code + one.web + one.desktop;

// Every day from `from` to `to`, cut at `today` (a day that has not happened has no row), a day with nothing at zero and
// no top app. The top app is the longest one a person opened: Windows' own background hosts (`systemName`) never take it.
export function dailyRows(from: string, to: string, totals: DayTotal[], claude: ClaudeDay[], apps: DayApp[], systemName: string, today: string): DailyRow[] {
  const totalOf = new Map(totals.map((one) => [one.day, one.seconds]));
  const claudeOf = new Map(claude.map((one) => [one.day, one]));
  const appsOf = new Map<string, DayApp[]>();
  for (const one of apps) appsOf.set(one.day, [...(appsOf.get(one.day) ?? []), one]);

  const rows: DailyRow[] = [];
  for (let day = from; day <= to && day <= today; day = addDays(day, 1)) {
    const parts = claudeOf.get(day) ?? { day, code: 0, web: 0, desktop: 0 };
    const top = readableApps(appsOf.get(day) ?? [], systemName).find((one) => one.app !== systemName);
    rows.push({
      day,
      total_seconds: totalOf.get(day) ?? 0,
      claude_code_seconds: parts.code,
      claude_ai_seconds: parts.web,
      claude_desktop_seconds: parts.desktop,
      claude_seconds: claudeTotal(parts),
      top_app: top?.app ?? "",
      top_app_seconds: top?.seconds ?? 0,
      uploaded: totalOf.has(day) ? 1 : 0,
    });
  }
  return rows;
}

// A spreadsheet runs a cell that opens with one of these; an app's name comes from the PC.
const FORMULA = /^[=+\-@\t\r]/;

function cell(value: string | number): string {
  const text = typeof value === "number" ? String(value) : FORMULA.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

const COLUMNS: (keyof DailyRow)[] = [
  "day",
  "total_seconds",
  "claude_code_seconds",
  "claude_ai_seconds",
  "claude_desktop_seconds",
  "claude_seconds",
  "top_app",
  "top_app_seconds",
  "uploaded",
];

// RFC 4180: comma, CRLF, a closing newline.
export function toCsv(rows: DailyRow[]): string {
  return [COLUMNS.join(","), ...rows.map((row) => COLUMNS.map((name) => cell(row[name])).join(","))].join("\r\n") + "\r\n";
}

// What «Semana» tells a week with no Claude time: nothing yet because no upload ever arrived (so «Llaves» is where to start),
// a source that never sent, or a source that sent but not this week.
export function claudeWeekHint(span: { lastReceived: Date | null; hasSites: boolean; hasClaudeCode: boolean }): "connect" | "never" | "none" {
  if (span.lastReceived === null) return "connect";
  return span.hasClaudeCode || span.hasSites ? "none" : "never";
}
