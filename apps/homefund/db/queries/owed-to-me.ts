import "server-only";

import { sql } from "drizzle-orm";

import { withUserDb, type Transaction } from "@/db/session";
import {
  creditLines,
  groupOwed,
  owedByPerson,
  type OwedCurrency,
  type OwedLine,
  type OwedLineKind,
  type OwedPerson,
} from "@/lib/owed-to-me";

type RawLine = {
  source: "credit" | "person";
  key: string;
  name: string;
  labelId: string | null;
  currency: string;
  line: OwedLineKind | "balance";
  occurredOn: string | null;
  cents: string | null;
  description: string | null;
  transactionId: string | null;
};

// Every line, both sources, in ONE statement. The policies scope each table, so a person's label and the movements
// carrying it answer only what the caller may read. A credit's lines are the receivable's opening, the transfers
// out of it and its balance; a person's are their expenses and the incomes marked «de <persona>», both through the
// movement-label join (RF-242). A reconciliation's adjustment is no spending and no return (RF-138).
function linesSql(onlyLabelId: string | null) {
  return sql`
    select 'credit' as source, 'credit:' || c.id::text as key, c.person_name as name, null::uuid as "labelId",
      l.settlement_currency as currency, 'opening' as line, r.initial_balance_on::text as "occurredOn",
      r.initial_balance_cents::text as cents, null::text as description, null::uuid as "transactionId"
    from third_party_credits c
    join accounts l on l.id = c.liability_account_id
    join accounts r on r.id = c.receivable_account_id
    where ${onlyLabelId}::uuid is null
    union all
    select 'credit', 'credit:' || c.id::text, c.person_name, null, l.settlement_currency, 'payment', t.occurred_at::text,
      t.amount_cents::text, null, t.id
    from third_party_credits c
    join accounts l on l.id = c.liability_account_id
    join transactions t on t.from_account_id = c.receivable_account_id and t.to_account_id is not null
      and t.currency = l.settlement_currency
    where ${onlyLabelId}::uuid is null
    union all
    select 'credit', 'credit:' || c.id::text, c.person_name, null, l.settlement_currency, 'balance', null,
      coalesce(rb.balance_cents, 0)::text, null, null
    from third_party_credits c
    join accounts l on l.id = c.liability_account_id
    left join account_balances rb on rb.id = c.receivable_account_id and rb.currency = l.settlement_currency
    where ${onlyLabelId}::uuid is null
    union all
    select 'person', 'person:' || p.id::text, p.name, p.id, t.currency,
      case when t.kind = 'expense' then 'spent' else 'returned' end, t.occurred_at::text,
      t.amount_cents::text, t.description, t.id
    from labels p
    join transaction_labels tl on tl.label_id = p.id
    join transactions t on t.id = tl.transaction_id
    where p.kind = 'person' and t.kind in ('expense', 'income') and t.reconciliation_id is null
      and (${onlyLabelId}::uuid is null and p.charge_default or p.id = ${onlyLabelId}::uuid)
    order by 2, 7`;
}

function peopleFrom(rows: RawLine[]): OwedPerson[] {
  // One person owes once per currency: their lines in two currencies are two figures (RF-124).
  const byKey = new Map<string, RawLine[]>();
  for (const row of rows) {
    const key = `${row.key}|${row.currency}`;
    byKey.set(key, [...(byKey.get(key) ?? []), row]);
  }

  return [...byKey.values()].map((own) => {
    const [first] = own;
    const money = (row: RawLine) => Number(row.cents);
    if (first.source === "credit") {
      const opening = own.find((row) => row.line === "opening");
      const balance = own.find((row) => row.line === "balance");
      const payments = own.filter((row) => row.line === "payment");
      const breakdown = creditLines(
        { cents: opening ? money(opening) : 0, on: opening?.occurredOn ?? "" },
        payments.map((row) => ({ on: row.occurredOn ?? "", cents: money(row) })),
        balance ? money(balance) : 0,
      );
      return { key: `${first.key}|${first.currency}`, name: first.name, currency: first.currency, cents: owedByPerson(breakdown), source: "credit", labelId: null, breakdown };
    }
    const breakdown: OwedLine[] = own.map((row) => ({
      kind: row.line === "spent" ? "spent" : "returned",
      occurredOn: row.occurredOn,
      cents: row.line === "spent" ? money(row) : -money(row),
      description: row.description,
      transactionId: row.transactionId,
    }));
    return { key: `${first.key}|${first.currency}`, name: first.name, currency: first.currency, cents: owedByPerson(breakdown), source: "person", labelId: first.labelId, breakdown };
  });
}

/**
 * What other people owe the caller, per currency and per person, in ONE round trip. Only what is still owed
 * appears: a person who returned it all, or paid ahead, is no line. Two currencies never add up (RF-124).
 */
export async function getOwedToMe(outerTx?: Transaction): Promise<OwedCurrency[]> {
  const rows = outerTx ? await outerTx.execute<RawLine>(linesSql(null)) : await withUserDb((tx) => tx.execute<RawLine>(linesSql(null)));
  return groupOwed(peopleFrom(rows));
}

export type PersonCurrencyLedger = {
  currency: string;
  spentCents: number;
  returnedCents: number;
  // What is still owed; below zero when they returned more than was spent.
  owedCents: number;
  spent: OwedLine[];
  returned: OwedLine[];
};

/** One person's ledger by currency, for their page: everything spent for them and everything they returned, whether or not it is charged. */
export async function getPersonLedger(labelId: string): Promise<PersonCurrencyLedger[]> {
  const rows = await withUserDb((tx) => tx.execute<RawLine>(linesSql(labelId)));
  const byCurrency = new Map<string, OwedLine[]>();
  for (const person of peopleFrom(rows)) {
    byCurrency.set(person.currency, [...(byCurrency.get(person.currency) ?? []), ...person.breakdown]);
  }
  return [...byCurrency]
    .map(([currency, lines]) => {
      const spent = lines.filter((line) => line.kind === "spent");
      const returned = lines.filter((line) => line.kind === "returned");
      return {
        currency,
        spentCents: owedByPerson(spent),
        returnedCents: -owedByPerson(returned),
        owedCents: owedByPerson(lines),
        spent,
        returned,
      };
    })
    .sort((a, b) => a.currency.localeCompare(b.currency));
}
