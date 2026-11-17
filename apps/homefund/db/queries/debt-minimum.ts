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
  paid = sql`false`,
  paidCents = sql`0`,
}: {
  fixed: SQL;
  pct: SQL;
  balance: SQL;
  statement: SQL;
  // `minimumPaidSql`: the period's minimum is covered, so none is asked again: the figure is null, never a zero.
  paid?: SQL;
  // What was paid in the period, taken off a fixed minimum so a part-payment asks only the rest.
  paidCents?: SQL;
}): SQL<number | null> {
  return sql`case
    when ${balance} >= 0 then 0
    when ${paid} then null::bigint
    when ${statement} is not null then ${statement}
    when ${fixed} is not null then greatest(${fixed} - ${paidCents}, 0)
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
  return sql`case when ${minimum} > 0 and ${paidSince({ account, currency, since: cutOff })} < ${minimum}
    then ${minimum} - ${paidSince({ account, currency, since: cutOff })} end`;
}

// The payments into the account after `since`, in the currency it bills in.
export function paidSince({ account, currency, since }: { account: SQL; currency: SQL; since: SQL }): SQL<number> {
  return sql`coalesce((
    select sum(p.amount_cents) from transactions p
    where p.to_account_id = ${account} and p.from_account_id is not null
      and p.currency = ${currency} and p.occurred_at > ${since}
  ), 0)`;
}

/**
 * The day the open period began: the latest closed statement's cut-off, else the latest cut-off the terms' day
 * names on or before `today`, else the first of the month. What was paid after it counts against that period's
 * minimum. `cutOffDay` and `statementCutOff` are SQL fragments; `today` is a civil date.
 */
export function periodStartSql({ statementCutOff, cutOffDay, today }: { statementCutOff: SQL; cutOffDay: SQL; today: string }): SQL {
  return sql`coalesce(${statementCutOff}, (
    select max(cand.d)
    from generate_series(date_trunc('month', ${today}::date) - interval '1 month', date_trunc('month', ${today}::date), interval '1 month') as mstart
    cross join lateral (select case when ${cutOffDay} is null then null else make_date(
      extract(year from mstart)::int, extract(month from mstart)::int,
      least(${cutOffDay}, extract(day from (mstart + interval '1 month - 1 day'))::int)) end as d) cand
    where cand.d <= ${today}::date
  ), date_trunc('month', ${today}::date)::date)`;
}

/**
 * True when what was paid since the period began covers that period's minimum: the printed statement's, else
 * the terms' fixed amount, else the percentage of what was owed before those payments. A card that never
 * had a minimum known is never «paid». `paid` is `paidSince`'s figure.
 */
export function minimumPaidSql({
  fixed,
  pct,
  balance,
  statementMinimum,
  paid,
}: {
  fixed: SQL;
  pct: SQL;
  balance: SQL;
  statementMinimum: SQL;
  paid: SQL;
}): SQL<boolean> {
  return sql`coalesce(${paid} > 0 and ${paid} >= coalesce(
    nullif(${statementMinimum}, 0), ${fixed}, round(-(${balance} - ${paid}) * ${pct})::bigint
  ) and coalesce(nullif(${statementMinimum}, 0), ${fixed}, round(-(${balance} - ${paid}) * ${pct})::bigint) > 0, false)`;
}

/**
 * What paying the statement in full asks now: the latest statement's closing balance less what was paid
 * after its cut-off, never more than is owed. With no statement, or one that closed at nothing owed, it is
 * everything owed. `balance` is the pocket's signed balance (negative while it owes), `statementClosing` the
 * statement's signed closing balance and `paid` is `paidSince`'s figure.
 */
export function totalDueSql({ balance, statementClosing, paid }: { balance: SQL; statementClosing: SQL; paid: SQL }): SQL<number> {
  return sql`case when ${statementClosing} < 0
    then greatest(0, least(greatest(0, -(${balance})), -(${statementClosing}) - ${paid}))
    else greatest(0, -(${balance})) end`;
}
