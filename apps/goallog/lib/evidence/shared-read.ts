import { sql } from "drizzle-orm";

import type { Transaction } from "@/lib/session";

import type { EvidenceReader } from "./types";

type Bound = Parameters<EvidenceReader>[0]["from"];

export type SharedRows = {
  searches: { day: string; quantity: number }[];
  timelog: { day: string; app: string; seconds: number }[];
};

type Row = { src: "s" | "t"; day: string; app: string | null; n: number };

// The evidence transaction pays one statement for every source that lives in
// this database, so a second source never costs a round trip (RNP-03). Each
// reader takes its own rows from the answer; the first to ask runs it. Every
// table is read under the person's settle, so its own policy narrows the rows.
const asked = new WeakMap<Transaction, { from: unknown; to: unknown; zone: string; rows: Promise<SharedRows> }>();

export function sharedRows(tx: Transaction, from: Bound, to: Bound, zone: string): Promise<SharedRows> {
  const earlier = asked.get(tx);
  if (earlier && earlier.from === from && earlier.to === to && earlier.zone === zone) return earlier.rows;
  // One `between`, so a goal's span bounds are spelled once: each source is shaped to (src, day, app, n) first,
  // a search counting 1 and a TimeLog row its seconds, and the window and the grouping apply to both. The window closes a parenthesis because the proof that reads the bounds off the wire ends `to` there.
  const rows = (async () => {
    const result = await tx.execute<Row>(sql`
      select src, day::text as day, app, sum(n)::int as n
        from (
          select * from (
            select 's' as src, (at at time zone ${zone})::date as day, null::text as app, 1 as n from "reading"."lookups"
            union all
            select 't', day, app, seconds from timelog.app_seconds
          ) u
          where day::date between ${from} and ${to}
        ) windowed
       group by src, day, app
       order by 2`);
    const out: SharedRows = { searches: [], timelog: [] };
    for (const row of result) {
      if (row.src === "s") out.searches.push({ day: row.day, quantity: row.n });
      else out.timelog.push({ day: row.day, app: row.app!, seconds: row.n });
    }
    return out;
  })();
  asked.set(tx, { from, to, zone, rows });
  return rows;
}
