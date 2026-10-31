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
};

export const claudeTotal = (one: Pick<ClaudeDay, "code" | "web" | "desktop">) => one.code + one.web + one.desktop;

// Every day from `from` to `to`, a day with nothing at zero and no top app. The top app is the longest one a person
// opened: Windows' own background hosts (`systemName`) never take it.
export function dailyRows(from: string, to: string, totals: DayTotal[], claude: ClaudeDay[], apps: DayApp[], systemName: string): DailyRow[] {
  const totalOf = new Map(totals.map((one) => [one.day, one.seconds]));
  const claudeOf = new Map(claude.map((one) => [one.day, one]));
  const appsOf = new Map<string, DayApp[]>();
  for (const one of apps) appsOf.set(one.day, [...(appsOf.get(one.day) ?? []), one]);

  const rows: DailyRow[] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) {
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
];

// RFC 4180: comma, CRLF, a closing newline.
export function toCsv(rows: DailyRow[]): string {
  return [COLUMNS.join(","), ...rows.map((row) => COLUMNS.map((name) => cell(row[name])).join(","))].join("\r\n") + "\r\n";
}
