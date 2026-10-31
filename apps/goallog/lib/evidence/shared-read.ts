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
  // `civil` is a CTE so `zone` is bound once: grouping by a second bind of it cannot be proved equal.
  const rows = (async () => {
    const result = await tx.execute<Row>(sql`
      with civil as (
        select (at at time zone ${zone})::date as day from reading.lookups
      )
      select 's' as src, day::text as day, null::text as app, count(*)::int as n
        from civil where day between ${from} and ${to} group by day
      union all
      select 't', day::text, app, sum(seconds)::int
        from timelog.app_seconds where day between ${from} and ${to} group by day, app
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
