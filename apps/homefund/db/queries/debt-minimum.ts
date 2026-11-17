import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

/**
 * The minimum payment owed on a liability (RF-78, RF-79), as one SQL expression.
 * A liability's balance is negative while it owes (RNF-05), so a balance at or
 * above zero owes nothing and asks `0` whatever the terms say. Below zero: the
 * latest closed statement's printed minimum while it is unpaid (`statement`, see
 * `unpaidStatementMinimumSql`), else the fixed amount when the terms name one, else
 * `pct` of what is owed rounded to the cent, else `null`: no figure is known, and a
 * screen says so instead of reading a zero as «owes nothing». Every operand is a SQL fragment.
 */
export function minimumPaymentSql({
  fixed,
  pct,
  balance,
  statement,
}: {
  fixed: SQL;
  pct: SQL;
  balance: SQL;
  statement: SQL;
}): SQL<number | null> {
  return sql`case
    when ${balance} >= 0 then 0
    when ${statement} is not null then ${statement}
    when ${fixed} is not null then ${fixed}
    when ${pct} is not null then round(-(${balance}) * ${pct})::bigint
    else null::bigint
  end`;
}

/**
 * What the latest closed statement printed as its minimum, while it is still unpaid: the
 * payments into the account after that cut-off, in the currency it bills in, have not yet
 * reached it. Null when the statement printed none, printed zero, or has been covered.
 * `account` and `currency` are the debt's id and settlement currency; `cutOff` and `minimum`
 * come from that statement's row.
 */
export function unpaidStatementMinimumSql({
  account,
  currency,
  cutOff,
  minimum,
}: {
  account: SQL;
  currency: SQL;
  cutOff: SQL;
  minimum: SQL;
}): SQL<number | null> {
  return sql`case when ${minimum} > 0 and coalesce((
    select sum(p.amount_cents) from transactions p
    where p.to_account_id = ${account} and p.from_account_id is not null
      and p.currency = ${currency} and p.occurred_at > ${cutOff}
  ), 0) < ${minimum} then ${minimum} end`;
}
