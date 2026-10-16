import "server-only";

import { sql } from "drizzle-orm";

import { withUserDb } from "@/db/session";
import type { CurrencyCode } from "@/lib/currency";

// One row per account AND currency (RF-121, RF-124): an account that holds two
// currencies answers twice, and nothing here ever adds two of them together.
export type AccountBalance = {
  accountId: string;
  currency: CurrencyCode;
  balanceCents: number;
};

/**
 * Every account's balance for the screen in one aggregate read of the
 * `account_balances` view (RNF-07, RNF-09): the view derives each balance from
 * movements, never a stored column. `accountIds` narrows the same query — never
 * one round trip per account.
 *
 * An account with no foreign movement still answers exactly one row, the one in
 * the currency it settles in: the view's `having` drops a pocket that nets to
 * zero unless it is the settlement one, which always survives. So a new account
 * and an account spent back to zero both keep a row, and only a currency the
 * account actually holds is ever added to that.
 */
export async function getAccountBalances(
  accountIds?: string[],
): Promise<AccountBalance[]> {
  return withUserDb(async (tx) => {
    // ONE json parameter carries the ids: drizzle expands a JS array in a
    // template into a comma-separated list, which is a record and not an array,
    // and `any(...)` over one is unusable at every arity — a single id reads as a
    // malformed array literal, two as a record that cannot cast, none as a
    // syntax error.
    const filter = accountIds
      ? sql`where id in (
          select value::uuid from jsonb_array_elements_text(${JSON.stringify(accountIds)}::jsonb)
        )`
      : sql``;

    const rows = await tx.execute<{
      id: string;
      currency: string;
      balance_cents: string;
    }>(sql`select id, currency, balance_cents from account_balances ${filter}`);

    // A bigint sum arrives from the driver as a string; the ledger keeps the
    // amount a number, in the minor unit of the currency beside it.
    return rows.map((row) => ({
      accountId: row.id,
      currency: row.currency,
      balanceCents: Number(row.balance_cents),
    }));
  });
}
