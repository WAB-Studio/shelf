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

// The first day on or after the purchase when the account's derived balance stood at zero or in
// credit: a payment covering the balance. The balance only moves on a movement's day, so those are
// the only days worth asking about.
async function readDeferrals(tx: Transaction, where: ReturnType<typeof sql>): Promise<DeferralRow[]> {
  const rows = await tx.execute<RawDeferral>(sql`
    select d.id, d.transaction_id as "transactionId", t.description, t.amount_cents::text as "amountCents",
      t.currency, t.occurred_at::text as "purchasedOn", d.instalments,
      (select min(x.day) from (
          select distinct t2.occurred_at as day from transactions t2
          where (t2.from_account_id = d.account_id or t2.to_account_id = d.account_id)
            and t2.occurred_at >= t.occurred_at
        ) x
        where private.account_settlement_balance_on(d.account_id, x.day) >= 0)::text as "clearedOn"
    from deferrals d
    join transactions t on t.id = d.transaction_id
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
  return withUserDb((tx) => readDeferrals(tx, sql`d.account_id = ${accountId}`));
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
        join accounts a on a.id = t.from_account_id and a.kind = 'liability'
        where t.id = ${transactionId} and private.can_write_account(a.id)`),
    ]);
    return { deferral: rows[0] ?? null, canDefer: can.length > 0 };
  });
}

/**
 * Writes the deferral of a purchase: a movement whose source is a liability account. Returns false
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
      join accounts a on a.id = t.from_account_id and a.kind = 'liability'
      where t.id = ${transactionId}
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
