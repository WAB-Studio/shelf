import "server-only";

import { sql } from "drizzle-orm";

import { withUserDb } from "@/db/session";
import type { CurrencyCode } from "@/lib/currency";

export type PersonExpense = {
  personId: string;
  name: string;
  color: string | null;
  // The currency the movements were booked in; a person spent for in two answers twice (RF-124).
  currency: CurrencyCode;
  spentCents: number;
};

/**
 * This window's expenses by the person they were for and by currency, largest first inside each currency, in
 * ONE round trip (RF-242). It sums the movement amounts, not the splits: a movement is for one person whatever
 * its lines. Only expenses count (RF-19) and a reconciliation's adjustment is no spending (RF-138).
 */
export async function getSpendingForPersons(range: {
  start: string;
  endExclusive: string;
}): Promise<PersonExpense[]> {
  return withUserDb(async (tx) => {
    const rows = await tx.execute<{
      person_id: string;
      name: string;
      color: string | null;
      currency: string;
      spent_cents: string;
    }>(sql`
      select l.id as person_id, l.name, l.color, t.currency, sum(t.amount_cents) as spent_cents
      from transaction_labels tl
      join labels l on l.id = tl.label_id and l.kind = 'person'
      join transactions t on t.id = tl.transaction_id
      where t.kind = 'expense' and t.reconciliation_id is null
        and t.occurred_at >= ${range.start} and t.occurred_at < ${range.endExclusive}
      group by l.id, l.name, l.color, t.currency
      order by t.currency, sum(t.amount_cents) desc
    `);

    return rows.map((row) => ({
      personId: row.person_id,
      name: row.name,
      color: row.color,
      currency: row.currency,
      spentCents: Number(row.spent_cents),
    }));
  });
}
