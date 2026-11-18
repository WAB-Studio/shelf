import "server-only";

import { sql } from "drizzle-orm";

import { scheduleOf, schedulePaymentsSql, scheduleRowsSql, type RawPayment, type RawRow } from "@/db/queries/loan-schedule";
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
  line: OwedLineKind;
  occurredOn: string | null;
  cents: string | null;
  description: string | null;
  transactionId: string | null;
  // A credit's schedule and payments, read where the figure is: only the credit's line carries them.
  scheduleRows: RawRow[] | null;
  schedulePayments: RawPayment[] | null;
};

// Every line, both sources, in ONE statement. The policies scope each table, so a person's label and the movements
// carrying it answer only what the caller may read. A credit is one line: the capital its loan still owes, read off
// the loan's own balance and never off the hidden receivable, so it is what the bank says is left (RF-301); its
// schedule rides along for «con intereses». A person's lines are what they already owed (RF-319), their expenses and the
// incomes marked «de <persona>», the last two through the movement-label join (RF-242); the opening is moved first
// below. A reconciliation's adjustment is no spending and no return (RF-138).
function linesSql(onlyLabelId: string | null) {
  return sql`
    select 'credit' as source, 'credit:' || c.id::text as key, c.person_name as name, null::uuid as "labelId",
      l.settlement_currency as currency, 'capital' as line, null::text as "occurredOn",
      greatest(0, -coalesce(lb.balance_cents, 0))::text as cents, null::text as description, null::uuid as "transactionId",
      ${scheduleRowsSql("l.id")} as "scheduleRows", ${schedulePaymentsSql("l.id", "l.settlement_currency")} as "schedulePayments"
    from third_party_credits c
    join accounts l on l.id = c.liability_account_id
    left join account_balances lb on lb.id = l.id and lb.currency = l.settlement_currency
    where ${onlyLabelId}::uuid is null
    union all
    select * from (
      select 'person' as source, 'person:' || p.id::text as key, p.name, p.id as "labelId", p.already_owed_currency as currency,
        'opening' as line, p.already_owed_since::text as "occurredOn", p.already_owed_cents::text as cents,
        null::text as description, null::uuid as "transactionId", null::jsonb as "scheduleRows", null::jsonb as "schedulePayments"
      from labels p
      where p.kind = 'person' and p.already_owed_cents is not null
        and (${onlyLabelId}::uuid is null and p.charge_default or p.id = ${onlyLabelId}::uuid)
      union all
      select 'person', 'person:' || p.id::text, p.name, p.id, t.currency,
        case when t.kind = 'expense' then 'spent' else 'returned' end, t.occurred_at::text,
        t.amount_cents::text, t.description, t.id, null::jsonb, null::jsonb
      from labels p
      join transaction_labels tl on tl.label_id = p.id
      join transactions t on t.id = tl.transaction_id
      where p.kind = 'person' and t.kind in ('expense', 'income') and t.reconciliation_id is null
        and (${onlyLabelId}::uuid is null and p.charge_default or p.id = ${onlyLabelId}::uuid)
    ) person_lines
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
      const capital = own.find((row) => row.line === "capital");
      const breakdown = creditLines(capital ? money(capital) : 0);
      const schedule = capital?.scheduleRows && capital.schedulePayments ? scheduleOf(capital.scheduleRows, capital.schedulePayments) : null;
      const withInterest =
        schedule !== null && schedule.remainingCount > 0 ? { cents: schedule.remainingTotalCents, count: schedule.remainingCount } : null;
      return { key: `${first.key}|${first.currency}`, name: first.name, currency: first.currency, cents: owedByPerson(breakdown), source: "credit", labelId: null, breakdown, withInterest };
    }
    const breakdown: OwedLine[] = own
      .map((row): OwedLine => ({
        kind: row.line === "opening" ? "opening" : row.line === "spent" ? "spent" : "returned",
        occurredOn: row.occurredOn,
        cents: row.line === "returned" ? -money(row) : money(row),
        description: row.description,
        transactionId: row.transactionId,
      }))
      // What they already owed leads its figure; Array.sort is stable, so the rest keeps its date order.
      .sort((a, b) => Number(b.kind === "opening") - Number(a.kind === "opening"));
    return { key: `${first.key}|${first.currency}`, name: first.name, currency: first.currency, cents: owedByPerson(breakdown), source: "person", labelId: first.labelId, breakdown, withInterest: null };
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
  // What they already owed, and the day it counts from (RF-319); zero and null when nothing was.
  openingCents: number;
  openingSince: string | null;
  spentCents: number;
  returnedCents: number;
  // What is still owed; below zero when they returned more than was spent.
  owedCents: number;
  spent: OwedLine[];
  returned: OwedLine[];
};

/** One person's ledger by currency, for their page: what they already owed, everything spent for them and everything they returned, whether or not it is charged. */
export async function getPersonLedger(labelId: string): Promise<PersonCurrencyLedger[]> {
  const rows = await withUserDb((tx) => tx.execute<RawLine>(linesSql(labelId)));
  const byCurrency = new Map<string, OwedLine[]>();
  for (const person of peopleFrom(rows)) {
    byCurrency.set(person.currency, [...(byCurrency.get(person.currency) ?? []), ...person.breakdown]);
  }
  return [...byCurrency]
    .map(([currency, lines]) => {
      const opening = lines.find((line) => line.kind === "opening");
      const spent = lines.filter((line) => line.kind === "spent");
      const returned = lines.filter((line) => line.kind === "returned");
      return {
        currency,
        openingCents: opening?.cents ?? 0,
        openingSince: opening?.occurredOn ?? null,
        spentCents: owedByPerson(spent),
        returnedCents: -owedByPerson(returned),
        owedCents: owedByPerson(lines),
        spent,
        returned,
      };
    })
    .sort((a, b) => a.currency.localeCompare(b.currency));
}
