import "server-only";

import { sql } from "drizzle-orm";

import { withUserDb, type Transaction } from "@/db/session";
import { deferralStatus, type DeferralStatus } from "@/lib/deferral";
import { todayInBogota } from "@/lib/dates";

export type DeferralRow = {
  id: string;
  transactionId: string;
  description: string | null;
  amountCents: number;
  currency: string;
  purchasedOn: string;
  instalments: number;
  // Derived on read from the purchase date and the account's balance, never stored (RF-136).
  status: DeferralStatus;
};

// The one predicate of what may be deferred: a purchase, an expense with no destination and no
// reconciliation, on a liability. `t` is the movement and `a` its source account.
export const deferrablePurchaseSql = sql.raw(
  "(t.from_account_id is not null and t.to_account_id is null and t.reconciliation_id is null and a.kind = 'liability')",
);

type RawDeferral = {
  id: string;
  transactionId: string;
  description: string | null;
  amountCents: string;
  currency: string;
  purchasedOn: string;
  instalments: number;
  clearedOn: string | null;
};

// The first day after the purchase when the account's derived balance reached zero or credit having been
// owed since the purchase: a payment covering the balance. A card already in credit when it bought, and
// never owing afterwards, has no such day. One running balance over the account's movements, in its
// settlement currency, the way `account_settlement_balance_on` lands each leg (RF-121, RF-124); the
// balance only moves on a movement's day, so those are the only days there are. The account is the
// purchase's own source, read through the movement, never the stored column.
async function readDeferrals(tx: Transaction, where: ReturnType<typeof sql>): Promise<DeferralRow[]> {
  const rows = await tx.execute<RawDeferral>(sql`
    select d.id, d.transaction_id as "transactionId", t.description, t.amount_cents::text as "amountCents",
      t.currency, t.occurred_at::text as "purchasedOn", d.instalments,
      (select min(x.day) from (
          select r.day, r.balance,
            coalesce(bool_or(r.balance < 0) over (order by r.day rows between unbounded preceding and 1 preceding), false) as was_owed
          from (
            select g.day, a.initial_balance_cents + sum(g.delta) over (order by g.day) as balance
            from (
              select t2.occurred_at as day,
                sum(case when t2.to_account_id = t.from_account_id then 1 else -1 end * case
                  when t2.currency = a.settlement_currency then t2.amount_cents
                  when t2.counter_amount_cents is not null and not t2.counter_is_estimate then t2.counter_amount_cents
                  else 0 end) as delta
              from transactions t2
              where t2.from_account_id = t.from_account_id or t2.to_account_id = t.from_account_id
              group by t2.occurred_at
            ) g
          ) r
          where r.day >= t.occurred_at
        ) x
        where x.day > t.occurred_at and x.balance >= 0 and x.was_owed)::text as "clearedOn"
    from deferrals d
    join transactions t on t.id = d.transaction_id and t.from_account_id = d.account_id
    join accounts a on a.id = t.from_account_id
    where ${where}
    order by t.occurred_at desc, d.created_at desc`);
  const today = todayInBogota();
  return rows.map((row) => ({
    id: row.id,
    transactionId: row.transactionId,
    description: row.description,
    amountCents: Number(row.amountCents),
    currency: row.currency,
    purchasedOn: row.purchasedOn,
    instalments: row.instalments,
    status: deferralStatus({
      amountCents: Number(row.amountCents),
      instalments: row.instalments,
      purchasedOn: row.purchasedOn,
      today,
      clearedOn: row.clearedOn,
    }),
  }));
}

/** The purchases of one liability that a person deferred, newest first (RF-136). */
export async function listDeferralsForAccount(accountId: string): Promise<DeferralRow[]> {
  return withUserDb((tx) => readDeferrals(tx, sql`t.from_account_id = ${accountId}`));
}

export type MovementDeferral = {
  deferral: DeferralRow | null;
  // The movement is a purchase on a liability the caller may write: the only one a person can defer.
  canDefer: boolean;
};

/** What the movement's detail needs: its deferral, if any, and whether it may be deferred. */
export async function getMovementDeferral(transactionId: string): Promise<MovementDeferral> {
  return withUserDb(async (tx) => {
    const [rows, can] = await Promise.all([
      readDeferrals(tx, sql`d.transaction_id = ${transactionId}`),
      tx.execute<{ ok: boolean }>(sql`
        select true as ok from transactions t
        join accounts a on a.id = t.from_account_id
        where t.id = ${transactionId} and ${deferrablePurchaseSql} and private.can_write_account(a.id)`),
    ]);
    return { deferral: rows[0] ?? null, canDefer: can.length > 0 };
  });
}

/**
 * Writes the deferral of a purchase: an expense whose source is a liability account. Returns false
 * when there is no such movement for the caller (absent, hidden, or not a purchase on a liability).
 * A second deferral of the same movement raises the unique violation.
 */
export async function createDeferral({
  transactionId,
  instalments,
}: {
  transactionId: string;
  instalments: number;
}): Promise<boolean> {
  return withUserDb(async (tx) => {
    const rows = await tx.execute<{ id: string }>(sql`
      insert into deferrals (transaction_id, account_id, instalments)
      select t.id, t.from_account_id, ${instalments}::smallint
      from transactions t
      join accounts a on a.id = t.from_account_id
      where t.id = ${transactionId} and ${deferrablePurchaseSql}
      returning id`);
    return rows.length > 0;
  });
}

/** Removes a movement's deferral; false when there was none the caller may remove. */
export async function deleteDeferral({ transactionId }: { transactionId: string }): Promise<boolean> {
  return withUserDb(async (tx) => {
    const rows = await tx.execute<{ id: string }>(
      sql`delete from deferrals where transaction_id = ${transactionId} returning id`,
    );
    return rows.length > 0;
  });
}
