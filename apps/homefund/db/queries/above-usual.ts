import { sql, type SQL } from "drizzle-orm";

import { ABOVE_USUAL_FACTOR, USUAL_MIN_LINES } from "@/lib/month-review-rules";

// RF-155's «above usual», written once for every query that asks it. Each query picks the history
// lines to group (its window differs); the median, the minimum of lines and the factor live here.

// A category's usual in a currency: the median of its lines' amounts.
export function usualMedianSql(amount: SQL): SQL {
  return sql`percentile_disc(0.5) within group (order by ${amount})`;
}

// A `having` clause: a usual rests on at least this many lines.
export const hasUsualHistorySql: SQL = sql`count(*) >= ${USUAL_MIN_LINES}::int`;

// A line is above usual when it passes the factor times the usual.
export function isAboveUsualSql(amount: SQL, median: SQL): SQL {
  return sql`${amount} > ${ABOVE_USUAL_FACTOR}::int * ${median}`;
}
