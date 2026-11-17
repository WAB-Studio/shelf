import "server-only";

import { sql } from "drizzle-orm";

import { insertRow } from "@/db/insert-row";
import { scheduleOf, schedulePaymentsSql, scheduleRowsSql, type RawPayment, type RawRow } from "@/db/queries/loan-schedule";
import { insertTransaction } from "@/db/queries/transactions";
import { categories, transactions } from "@/db/schema";
import type { Account } from "@/db/schema";
import { withUserDb, type Transaction } from "@/db/session";
import { pgErrorCode } from "@/lib/db-error";
import { splitInstalment, type InstalmentBasis } from "@/lib/loan-instalment";
import { rowToPay } from "@/lib/loan-schedule";

class InstalmentRefusal extends Error {
  readonly code = "23514";
}

// The names a person's interest category goes by, best first. Interest is not a tax: no other bucket stands in.
const INTEREST_CATEGORY_NAMES = ["intereses", "intereses de deuda", "interest"];
const NEW_CATEGORY_NAME = "Intereses";
const NEW_CATEGORY_COLOR = "#64748B";

export type LoanInstalmentResult = {
  // The transfer that brought the capital down, or the interest's expense when the whole payment was interest.
  transactionId: string;
  interestCents: number;
  capitalCents: number;
  basis: InstalmentBasis;
};

type LoanRead = {
  from_kind: Account["kind"] | null;
  to_kind: Account["kind"] | null;
  to_subtype: Account["subtype"] | null;
  owed_cents: string;
  annual_rate: string | null;
  days: number;
  rows: RawRow[];
  payments: RawPayment[];
  scope_owner: string | null;
  scope_group: string | null;
  category_id: string | null;
};

/**
 * Pays an instalment of a loan from an asset, split into interest and capital (RF-282), in ONE `withUserDb`: what
 * the loan owes, its stored rate, the days since its last payment, its schedule and the person's interest category
 * come back in one statement; then the interest is booked as an expense of the source in that category and the
 * capital as the transfer into the loan. The loan therefore comes down by the capital alone.
 *
 * With a schedule the cuota the payment pays is the oldest row not yet paid (`rowToPay`), whatever the payment's day, so the row's
 * interest and insurance are the interest, less what an earlier part-payment of it covered, and the loan comes down by
 * that row's capital. The interest expense carries the transfer's reference plus «:interest», which is how the schedule
 * counts it toward the cuota.
 *
 * A resent `requestRef` answers with the transfer the first copy booked, and books nothing.
 */
export async function recordLoanInstalment({
  fromAccountId,
  toAccountId,
  amountCents,
  occurredAt,
  requestRef,
  extra = false,
}: {
  fromAccountId: string;
  toAccountId: string;
  amountCents: number;
  occurredAt: string;
  requestRef?: string;
  // An extra payment goes whole to capital, as does any payment into a debt that is not a loan.
  extra?: boolean;
}): Promise<LoanInstalmentResult> {
  const capitalRef = requestRef ? `form:${requestRef}` : null;
  const formInterestRef = requestRef ? `form:${requestRef}:interest` : null;

  try {
    return await withUserDb(async (tx) => {
      const [read] = await tx.execute<LoanRead>(sql`
        select
          (select a.kind from accounts a where a.id = ${fromAccountId}) as from_kind,
          l.kind as to_kind,
          l.subtype as to_subtype,
          greatest(0, -coalesce((select b.balance_cents from account_balances b
            where b.id = l.id and b.currency = l.settlement_currency), 0))::text as owed_cents,
          (select dt.annual_rate::text from debt_terms dt where dt.account_id = l.id) as annual_rate,
          greatest(0, ${occurredAt}::date - coalesce((
            select max(t.occurred_at) from transactions t
            where t.to_account_id = l.id and t.from_account_id is not null and t.occurred_at <= ${occurredAt}::date
          ), l.initial_balance_on)) as days,
          ${scheduleRowsSql("l.id")} as rows,
          ${schedulePaymentsSql("l.id", "l.settlement_currency")} as payments,
          src.owner_user_id as scope_owner, src.group_id as scope_group,
          (select c.id from categories c
            where c.kind = 'expense' and c.parent_id is null
              and ((c.owner_user_id is not null and c.owner_user_id = src.owner_user_id)
                or (c.group_id is not null and c.group_id = src.group_id))
              and lower(c.name) = any(${sql.raw(`array[${INTEREST_CATEGORY_NAMES.map((name) => `'${name}'`).join(",")}]`)})
            order by array_position(${sql.raw(`array[${INTEREST_CATEGORY_NAMES.map((name) => `'${name}'`).join(",")}]`)}, lower(c.name))
            limit 1) as category_id
        from accounts l
        left join accounts src on src.id = ${fromAccountId}
        where l.id = ${toAccountId}
      `);

      // An account the policies did not show reads as absent: the insert below answers it with 42501.
      if (!read) throw new InstalmentRefusal("a debt payment credits a liability account");
      if (read.from_kind !== null && read.from_kind !== "asset") {
        throw new InstalmentRefusal("a debt payment comes from an asset account");
      }
      if (read.to_kind !== "liability") throw new InstalmentRefusal("a debt payment credits a liability account");

      const schedule = scheduleOf(read.rows, read.payments);
      const split =
        extra || read.to_subtype !== "loan"
          ? { interestCents: 0, capitalCents: amountCents, basis: "none" as const }
          : splitInstalment({
              amountCents,
              owedCents: Number(read.owed_cents),
              annualRate: read.annual_rate,
              days: read.days,
              row: schedule === null ? null : rowToPay(schedule.rows),
            });

      let capitalId: string | null = null;
      // A payment with no capital and no interest is one of nothing: the transfer is attempted so its own
      // constraint refuses it, as it always has.
      if (split.capitalCents > 0 || split.interestCents === 0) {
        const [txn] = await insertRow(
          tx,
          transactions,
          { fromAccountId, toAccountId, amountCents: split.capitalCents, occurredAt, externalRef: capitalRef },
          { returning: { id: transactions.id } },
        );
        capitalId = txn.id;
      }

      let interestId: string | null = null;
      if (split.interestCents > 0) {
        const categoryId = read.category_id ?? (await openInterestCategory(tx, read));
        const loanName = await tx.execute<{ name: string }>(sql`select name from accounts where id = ${toAccountId}`);
        interestId = (
          await insertTransaction(tx, {
            fromAccountId,
            toAccountId: null,
            amountCents: split.interestCents,
            occurredAt,
            description: `Intereses ${loanName[0]?.name ?? ""}`.trim(),
            // Without a request the transfer's reference is its own id, so the interest names the transfer it came with.
            externalRef: formInterestRef ?? (capitalId ? `${capitalId}:interest` : null),
            splits: [{ categoryId, amountCents: split.interestCents }],
            labelIds: [],
          })
        ).transactionId;
      }

      return { transactionId: (capitalId ?? interestId)!, ...split };
    });
  } catch (error) {
    if (!capitalRef || pgErrorCode(error) !== "23505") throw error;

    // The first copy booked both rows in one transaction, so either ref names it.
    const rows = await withUserDb((tx) =>
      tx.execute<{ id: string; amount_cents: string; interest: boolean }>(sql`
        select t.id, t.amount_cents::text, (t.to_account_id is null) as interest from transactions t
        where t.external_ref in (${capitalRef}, ${formInterestRef})
          and (t.to_account_id = ${toAccountId} or t.from_account_id = ${fromAccountId})
      `),
    );
    const capital = rows.find((row) => !row.interest);
    const interest = rows.find((row) => row.interest);
    const first = capital ?? interest;
    if (!first) throw error;

    const interestCents = interest ? Number(interest.amount_cents) : 0;
    const capitalCents = capital ? Number(capital.amount_cents) : 0;
    return { transactionId: first.id, interestCents, capitalCents, basis: "rate" };
  }
}

// A person with no interest category gets one named for it, in the scope the source account lives in.
async function openInterestCategory(tx: Transaction, read: Pick<LoanRead, "scope_owner" | "scope_group">): Promise<string> {
  const [row] = await insertRow(
    tx,
    categories,
    {
      ownerUserId: read.scope_owner,
      groupId: read.scope_group,
      name: NEW_CATEGORY_NAME,
      kind: "expense",
      parentId: null,
      color: NEW_CATEGORY_COLOR,
    },
    { returning: { id: categories.id } },
  );
  return row.id;
}
