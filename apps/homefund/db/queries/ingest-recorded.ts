import { sql } from "drizzle-orm";

// A movement a person already recorded by hand (or Claude did) for a delivery still waiting: the same figure
// within a day, on the account the delivery names (any account when it names none), the same way round.
// A movement an acceptance wrote is no match, so two equal coffees stay two. Derived on every read, never
// stored, so a movement recorded after the bank's message marks it as well. The outer columns are written
// qualified: drizzle renders an embedded column bare inside a projection, and a bare name would bind to the
// subquery's own table.
export type RecordedMovement = { transactionId: string; description: string | null; occurredOn: string };

const delivery = (column: string) => sql.raw(`"ingest_deliveries"."${column}"`);

export const recordedMovementSql = sql<RecordedMovement | null>`(
  select jsonb_build_object('transactionId', t.id, 'description', t.description, 'occurredOn', t.occurred_at)
  from transactions t
  where ${delivery("status")} = 'pending'
    and ${delivery("proposed_amount_cents")} is not null
    and ${delivery("proposed_occurred_at")} is not null
    and t.reconciliation_id is null
    and t.amount_cents = ${delivery("proposed_amount_cents")}
    and t.occurred_at between ${delivery("proposed_occurred_at")} - 1 and ${delivery("proposed_occurred_at")} + 1
    and case ${delivery("proposed_direction")}
      when 'income' then t.from_account_id is null
        and (${delivery("proposed_account_id")} is null or t.to_account_id = ${delivery("proposed_account_id")})
      when 'transfer' then t.from_account_id = ${delivery("proposed_account_id")}
        and t.to_account_id = ${delivery("proposed_to_account_id")}
      when 'expense' then t.to_account_id is null
        and (${delivery("proposed_account_id")} is null or t.from_account_id = ${delivery("proposed_account_id")})
      else ${delivery("proposed_account_id")} in (t.from_account_id, t.to_account_id)
    end
    and not exists (select 1 from ingest_deliveries made where made.transaction_id = t.id)
  order by abs(t.occurred_at - ${delivery("proposed_occurred_at")}), t.created_at
  limit 1
)`.mapWith((raw: unknown) => {
  if (raw === null || raw === undefined) return null;
  return (typeof raw === "string" ? JSON.parse(raw) : raw) as RecordedMovement;
});
