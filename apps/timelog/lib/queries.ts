import "server-only";

import { sql } from "drizzle-orm";

import { withTimeDb } from "@/lib/session";

export type AppTime = { app: string; seconds: number };
export type DayTotal = { day: string; seconds: number };
export type SiteTime = { host: string; seconds: number };
// One day's Claude time by where it was spent: the CLI, claude.ai in a browser, the desktop app.
export type ClaudeDay = { day: string; code: number; web: number; desktop: number };
export type WindowTime = { app: string; title: string; seconds: number };
export type PageTime = { host: string; url: string; title: string; seconds: number };
// A Claude Code session on the days asked: its project folder as Claude Code named it, the first and last message, the seconds.
export type ClaudeSessionTime = { session: string; project: string; first: Date; last: Date; seconds: number };
export type DeviceTime = { device: string; seconds: number };
export type DayApp = { day: string; app: string; seconds: number };

// Every device added: one app on two PCs is one row. Longest first, then by name.
export async function appsBetween(from: string, to: string): Promise<AppTime[]> {
  const rows = await withTimeDb((tx) =>
    tx.execute<{ app: string; seconds: number }>(sql`
      select app, sum(seconds)::int as seconds
        from timelog.app_seconds
       where day between ${from}::date and ${to}::date
       group by app
       order by seconds desc, app`),
  );
  return [...rows];
}

// Each device's total in the range, longest first. Two PCs on at once add up in every other total here.
export async function devicesBetween(from: string, to: string): Promise<DeviceTime[]> {
  const rows = await withTimeDb((tx) =>
    tx.execute<DeviceTime>(sql`
      select device, sum(seconds)::int as seconds
        from timelog.app_seconds
       where day between ${from}::date and ${to}::date
       group by device
       order by seconds desc, device`),
  );
  return [...rows];
}

// Each day's total in the range; a day with nothing is absent.
export async function dayTotals(from: string, to: string): Promise<DayTotal[]> {
  const rows = await withTimeDb((tx) =>
    tx.execute<{ day: string; seconds: number }>(sql`
      select to_char(day, 'YYYY-MM-DD') as day, sum(seconds)::int as seconds
        from timelog.app_seconds
       where day between ${from}::date and ${to}::date
       group by day
       order by day`),
  );
  return [...rows];
}

// Every device added, longest first, then by name. Hostnames only (RT-13).
export async function sitesBetween(from: string, to: string): Promise<SiteTime[]> {
  const rows = await withTimeDb((tx) =>
    tx.execute<{ host: string; seconds: number }>(sql`
      select host, sum(seconds)::int as seconds
        from timelog.site_seconds
       where day between ${from}::date and ${to}::date
       group by host
       order by seconds desc, host`),
  );
  return [...rows];
}

// Claude's time per day (RT-14): Claude Code, claude.ai in the browser and the desktop app (a process named
// Claude), one statement. A day with none of the three is absent.
export async function claudeBetween(from: string, to: string): Promise<ClaudeDay[]> {
  const rows = await withTimeDb((tx) =>
    tx.execute<ClaudeDay>(sql`
      select to_char(day, 'YYYY-MM-DD') as day, sum(code)::int as code, sum(web)::int as web, sum(desktop)::int as desktop
        from (
          select day, seconds as code, 0 as web, 0 as desktop from timelog.claude_code_seconds
           where day between ${from}::date and ${to}::date
          union all
          select day, 0, seconds, 0 from timelog.site_seconds
           where host = 'claude.ai' and day between ${from}::date and ${to}::date
          union all
          select day, 0, 0, seconds from timelog.app_seconds
           where lower(regexp_replace(app, '[.]exe$', '', 'i')) = 'claude' and day between ${from}::date and ${to}::date
        ) parts
       group by day
       order by day`),
  );
  return [...rows];
}

// Window titles inside apps, every device added (RT-18). Longest first.
export async function windowsBetween(from: string, to: string): Promise<WindowTime[]> {
  const rows = await withTimeDb((tx) =>
    tx.execute<WindowTime>(sql`
      select app, title, sum(seconds)::int as seconds
        from timelog.window_seconds
       where day between ${from}::date and ${to}::date
       group by app, title
       order by seconds desc, app, title`),
  );
  return [...rows];
}

// Pages, every device added (RT-18). Longest first.
export async function pagesBetween(from: string, to: string): Promise<PageTime[]> {
  const rows = await withTimeDb((tx) =>
    tx.execute<PageTime>(sql`
      select host, url, title, sum(seconds)::int as seconds
        from timelog.page_seconds
       where day between ${from}::date and ${to}::date
       group by host, url, title
       order by seconds desc, url, title`),
  );
  return [...rows];
}

// Claude Code sessions that worked in the range (RT-19): a session over two devices or two days is one row.
export async function claudeSessionsBetween(from: string, to: string): Promise<ClaudeSessionTime[]> {
  const rows = await withTimeDb((tx) =>
    tx.execute<{ session: string; project: string; first: string; last: string; seconds: number }>(sql`
      select session, min(project) as project, min(first_at) as first, max(last_at) as last, sum(seconds)::int as seconds
        from timelog.claude_sessions
       where day between ${from}::date and ${to}::date
       group by session
       order by seconds desc, session`),
  );
  return rows.map((row) => ({ ...row, first: new Date(row.first), last: new Date(row.last) }));
}

// Each day's apps over a range, for the export's top app. Rows per day, not a day's whole list at a time.
export async function appsByDay(from: string, to: string): Promise<DayApp[]> {
  const rows = await withTimeDb((tx) =>
    tx.execute<DayApp>(sql`
      select to_char(day, 'YYYY-MM-DD') as day, app, sum(seconds)::int as seconds
        from timelog.app_seconds
       where day between ${from}::date and ${to}::date
       group by day, app
       order by day, seconds desc, app`),
  );
  return [...rows];
}

export type UploadSpan = { firstDay: string | null; lastReceived: Date | null; hasSites: boolean; hasClaudeCode: boolean };

// The first day ever uploaded, the moment of the last upload, and whether sites or Claude Code ever arrived,
// in one statement.
export async function uploadSpan(): Promise<UploadSpan> {
  const rows = await withTimeDb((tx) =>
    tx.execute<{ first_day: string | null; last_received: string | null; has_sites: boolean; has_claude: boolean }>(sql`
      select to_char(min(day), 'YYYY-MM-DD') as first_day, max(received_at) as last_received,
             exists (select 1 from timelog.site_seconds) as has_sites,
             exists (select 1 from timelog.claude_code_seconds) as has_claude
        from timelog.app_seconds`),
  );
  const row = rows[0];
  return {
    firstDay: row?.first_day ?? null,
    lastReceived: row?.last_received ? new Date(row.last_received) : null,
    hasSites: row?.has_sites ?? false,
    hasClaudeCode: row?.has_claude ?? false,
  };
}

type KeyRow = { id: string; name: string; lastUsedAt: Date | null; revoked: boolean };

export async function listKeys(): Promise<KeyRow[]> {
  const rows = await withTimeDb((tx) =>
    tx.execute<{ id: string; name: string; last_used_at: string | null; revoked_at: string | null }>(sql`
      select id, name, last_used_at, revoked_at
        from timelog.access_keys
       order by revoked_at is not null, created_at desc`),
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    lastUsedAt: row.last_used_at ? new Date(row.last_used_at) : null,
    revoked: row.revoked_at !== null,
  }));
}
