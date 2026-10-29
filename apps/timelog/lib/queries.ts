import "server-only";

import { sql } from "drizzle-orm";

import { withTimeDb } from "@/lib/session";

export type AppTime = { app: string; seconds: number };
export type DayTotal = { day: string; seconds: number };

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

// The first day ever uploaded and the moment of the last upload, in one statement.
export async function uploadSpan(): Promise<{ firstDay: string | null; lastReceived: Date | null }> {
  const rows = await withTimeDb((tx) =>
    tx.execute<{ first_day: string | null; last_received: string | null }>(sql`
      select to_char(min(day), 'YYYY-MM-DD') as first_day, max(received_at) as last_received
        from timelog.app_seconds`),
  );
  const row = rows[0];
  return {
    firstDay: row?.first_day ?? null,
    lastReceived: row?.last_received ? new Date(row.last_received) : null,
  };
}

export type KeyRow = { id: string; name: string; hint: string; lastUsedAt: Date | null; revoked: boolean };

export async function listKeys(): Promise<KeyRow[]> {
  const rows = await withTimeDb((tx) =>
    tx.execute<{ id: string; name: string; hint: string; last_used_at: string | null; revoked_at: string | null }>(sql`
      select id, name, hint, last_used_at, revoked_at
        from timelog.access_keys
       order by revoked_at is not null, created_at desc`),
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    hint: row.hint,
    lastUsedAt: row.last_used_at ? new Date(row.last_used_at) : null,
    revoked: row.revoked_at !== null,
  }));
}
