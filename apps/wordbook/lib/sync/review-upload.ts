import "server-only";

import { sql } from "drizzle-orm";

import type { Transaction } from "@/lib/session";
import { REVIEW_BATCH, REVIEW_ENTRY_CAP, type ReviewCursor, type ReviewWireEntry } from "@/lib/sync/review-protocol";

// One jsonb parameter, read back through typed columns, for the reason `./upload` gives. A null half is left out
// of the object: `jsonb_to_recordset` reads a JSON null into a `jsonb` column as the value `null`, not as NULL.
function sentEntries(entries: ReviewWireEntry[]): string {
  return JSON.stringify(
    entries.map((entry) => ({
      key: entry.key,
      at: entry.at,
      gone: entry.gone,
      card: entry.card ?? undefined,
      sense: entry.sense ?? undefined,
    })),
  );
}

export type DownloadedEntry = {
  key: string;
  at: number;
  gone: boolean;
  card: ReviewWireEntry["card"];
  sense: ReviewWireEntry["sense"];
  updated_at: string;
};

export type ReviewRound = { accepted: number; full: boolean; entries: DownloadedEntry[] };

// Copies the device's entries up and reads the ones changed since `since`, in one statement (RL-93). The row with
// the later `at` replaces the other; the half a newer row lacks is kept from the older, and a deletion keeps
// neither. The reader's rows are bounded by `cap`: past it nothing is written, and the answer says `full`. The download is read from the
// snapshot before the write, so an entry this round wrote comes back once in the next one, a merge that changes
// nothing. `updated_at` travels as UTC wall-clock text with no zone marker, for the reason `downloadRows` gives.
export async function syncReviewEntries(
  tx: Transaction,
  userId: string,
  entries: ReviewWireEntry[],
  since: ReviewCursor | null,
  cap: number = REVIEW_ENTRY_CAP,
): Promise<ReviewRound> {
  // Cast from text so the parameter keeps its own OID and the microseconds survive (see `downloadRows`).
  const boundary = since
    ? sql`and (e.updated_at, e.key) > (${since.updatedAt}::text::timestamptz, ${since.key}::text)`
    : sql``;

  const [state] = await tx.execute<{ allowed: boolean; accepted: number; entries: DownloadedEntry[] }>(sql`
    with sent as (
      select r.key, r."at", r.gone, r.card, r.sense
      from jsonb_to_recordset(${sentEntries(entries)}::text::jsonb) as r(
        key text, "at" bigint, gone boolean, card jsonb, sense jsonb
      )
    ),
    gate as (
      select (count(*) + (select count(*) from sent) <= ${cap}) as allowed
      from reading.review_entries where user_id = ${userId}
    ),
    written as (
      insert into reading.review_entries (user_id, key, "at", gone, card, sense)
      select ${userId}, key, "at", gone, card, sense from sent
      where (select allowed from gate)
      on conflict (user_id, key) do update set
        "at" = excluded."at",
        gone = excluded.gone,
        card = case when excluded.gone then null else coalesce(excluded.card, review_entries.card) end,
        sense = case when excluded.gone then null else coalesce(excluded.sense, review_entries.sense) end
      where excluded."at" > review_entries."at"
      returning 1
    )
    select (select allowed from gate) as allowed,
      (select count(*) from written)::int as accepted,
      (
        select coalesce(
          json_agg(
            json_build_object(
              'key', page.key, 'at', page."at", 'gone', page.gone, 'card', page.card, 'sense', page.sense,
              'updated_at', to_json(timezone('utc', page.updated_at))
            )
            order by page.updated_at, page.key
          ),
          '[]'::json
        )
        from (
          select e.key, e."at", e.gone, e.card, e.sense, e.updated_at
          from reading.review_entries e
          where e.user_id = auth.uid() ${boundary}
          order by e.updated_at, e.key
          limit ${REVIEW_BATCH}
        ) page
      ) as entries
  `);

  return { accepted: state.accepted, full: !state.allowed, entries: state.entries };
}
