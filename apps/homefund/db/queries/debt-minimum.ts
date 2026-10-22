import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

/**
 * The minimum payment owed on a liability (RF-78, RF-79), as one SQL expression.
 * A liability's balance is negative while it owes (RNF-05), so a balance at or
 * above zero owes nothing and asks `0` whatever the terms say. Below zero: the
 * fixed amount when the terms name one, else `pct` of what is owed rounded to the
 * cent, else the caller's `fallback` — `0` for a statement, `null` for an overview
 * that shows nothing. Every operand is a SQL fragment.
 */
export function minimumPaymentSql({
  fixed,
  pct,
  balance,
  fallback,
}: {
  fixed: SQL;
  pct: SQL;
  balance: SQL;
  fallback: SQL;
}): SQL<number | null> {
  return sql`case
    when ${balance} >= 0 then 0
    when ${fixed} is not null then ${fixed}
    when ${pct} is not null then round(-(${balance}) * ${pct})::bigint
    else ${fallback}
  end`;
}
