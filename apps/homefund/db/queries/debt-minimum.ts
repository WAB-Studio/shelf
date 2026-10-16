import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

/**
 * The minimum payment owed on a liability (RF-78, RF-79), as one SQL expression:
 * the fixed amount when the terms name one, else `pct` of the balance's magnitude
 * rounded to the cent, else the caller's `fallback` — `0` for a statement, `null`
 * for an overview that shows nothing. Every operand is a SQL fragment.
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
    when ${fixed} is not null then ${fixed}
    when ${pct} is not null then round(abs(${balance}) * ${pct})::bigint
    else ${fallback}
  end`;
}
