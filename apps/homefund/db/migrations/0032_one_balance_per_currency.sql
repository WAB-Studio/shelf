-- RF-121 to RF-124: a movement carries the currency it happened in, and a card that bills in pesos
-- and buys in dollars holds both at once. `currency` lands with 'COP' so every row already stored is
-- read as what it always was, and the default then goes: from here on a null is how a writer says
-- "derive it", and `set_transaction_currency` below takes it from the accounts. That is what keeps
-- the ten insert paths that name no currency working untouched.
ALTER TABLE "transactions" ADD COLUMN "currency" text DEFAULT 'COP' NOT NULL;--> statement-breakpoint
ALTER TABLE "transactions" ALTER COLUMN "currency" DROP DEFAULT;--> statement-breakpoint
-- The same movement in the other side's settlement currency (RF-122). Two integers, each in its own
-- minor unit: the rate is their quotient, derived to be read and never stored, because a stored rate
-- is money in floating point.
ALTER TABLE "transactions" ADD COLUMN "counter_amount_cents" bigint;--> statement-breakpoint
-- True while the counter amount is what a person expects, false once the statement says what the
-- issuer billed (RF-123). The balance moves currency when it flips.
ALTER TABLE "transactions" ADD COLUMN "counter_is_estimate" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_currency_iso" CHECK ("transactions"."currency" ~ '^[A-Z]{3}$');--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_counter_amount_positive" CHECK ("transactions"."counter_amount_cents" is null or "transactions"."counter_amount_cents" > 0);--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_estimate_needs_counter" CHECK ("transactions"."counter_is_estimate" = false or "transactions"."counter_amount_cents" is not null);--> statement-breakpoint
-- A writer that names no currency gets the one the source account settles in, or the destination's
-- when the movement is an income. Mirrors `set_transaction_scope`: what the accounts say, not what
-- the caller chose. INSERT only — an UPDATE that changes the currency is deliberate and column-granted.
create or replace function private.set_transaction_currency() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_from text;
  v_to text;
begin
  if new.currency is not null then
    return new;
  end if;
  select a.settlement_currency into v_from from public.accounts a where a.id = new.from_account_id;
  select a.settlement_currency into v_to from public.accounts a where a.id = new.to_account_id;
  new.currency := coalesce(v_from, v_to);
  return new;
end;
$$;
revoke all on function private.set_transaction_currency() from public, anon, authenticated, service_role;--> statement-breakpoint
-- The second amount is required exactly when a named account settles somewhere else, and forbidden
-- when none does, so no movement carries a rate it does not need or hides one it does. An estimate
-- waits for a statement (RF-123), which only a one-sided movement does: a transfer is confirmed
-- whole when it is recorded (RF-122).
--
-- Every refusal here carries `23901`, not `check_violation`: class 23 is what an integrity rule
-- raises, and `514` is already the code the split, scope and placement triggers have raised since
-- `0001`. The `9xx` subclass is in neither the standard's range nor Postgres's own `P` extension
-- space, so nothing can claim it out from under us, and the action layer tells a currency refusal
-- from a category out of scope by the code alone — never by the sentence.
create or replace function private.assert_transaction_currency() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_from text;
  v_to text;
  v_foreign boolean;
begin
  select a.settlement_currency into v_from from public.accounts a where a.id = new.from_account_id;
  select a.settlement_currency into v_to from public.accounts a where a.id = new.to_account_id;
  if v_from is not null and v_to is not null and v_from is distinct from v_to
     and new.currency not in (v_from, v_to) then
    raise exception 'a transfer between two currencies is booked in one of them' using errcode = '23901';
  end if;
  v_foreign := (v_from is not null and v_from <> new.currency) or (v_to is not null and v_to <> new.currency);
  if v_foreign and new.counter_amount_cents is null then
    raise exception 'a movement in another currency carries its amount in the account''s own' using errcode = '23901';
  end if;
  if not v_foreign and new.counter_amount_cents is not null then
    raise exception 'a movement in the account''s own currency carries no second amount' using errcode = '23901';
  end if;
  if new.counter_is_estimate and num_nonnulls(new.from_account_id, new.to_account_id) = 2 then
    raise exception 'only a one-sided movement carries an estimate' using errcode = '23901';
  end if;
  return new;
end;
$$;
revoke all on function private.assert_transaction_currency() from public, anon, authenticated, service_role;--> statement-breakpoint
-- Postgres fires BEFORE row triggers in name order, so the setter must sort before the check:
-- `transactions_set_currency` runs, then `..._set_external_ref`, `..._set_scope`, `..._set_timestamps`,
-- and `transactions_verify_currency` last, on a row that already carries its derived currency.
CREATE TRIGGER transactions_set_currency BEFORE INSERT ON "transactions"
  FOR EACH ROW EXECUTE FUNCTION private.set_transaction_currency();--> statement-breakpoint
CREATE TRIGGER transactions_verify_currency BEFORE INSERT OR UPDATE ON "transactions"
  FOR EACH ROW EXECUTE FUNCTION private.assert_transaction_currency();--> statement-breakpoint
-- Column-scoped, as everywhere else: RLS and `can_write_transaction` still bound which rows, the
-- checks and the triggers above the values.
GRANT INSERT (currency, counter_amount_cents, counter_is_estimate), UPDATE (currency, counter_amount_cents, counter_is_estimate) ON TABLE "transactions" TO authenticated;--> statement-breakpoint
-- RNF-09: the index-only scan survives if and only if every column the view reads rides in the
-- index. The view now reads `amount_cents`, `counter_amount_cents`, `currency` and
-- `counter_is_estimate`, so the six covering indexes — 0017's two account-only partials and 0001's
-- four scope-leading composites — are recreated with all four in INCLUDE. Grouping by currency on
-- top costs nothing: it is a HashAggregate over the same tuples. Leaving one column out of INCLUDE
-- is what drops the plan to the heap.
DROP INDEX "transactions_from_account_id_idx";--> statement-breakpoint
DROP INDEX "transactions_to_account_id_idx";--> statement-breakpoint
CREATE INDEX "transactions_from_account_id_idx" ON "transactions" USING btree ("from_account_id") INCLUDE ("amount_cents","counter_amount_cents","currency","counter_is_estimate") WHERE from_account_id is not null;--> statement-breakpoint
CREATE INDEX "transactions_to_account_id_idx" ON "transactions" USING btree ("to_account_id") INCLUDE ("amount_cents","counter_amount_cents","currency","counter_is_estimate") WHERE to_account_id is not null;--> statement-breakpoint
DROP INDEX "transactions_group_from_balance_idx";--> statement-breakpoint
DROP INDEX "transactions_group_to_balance_idx";--> statement-breakpoint
DROP INDEX "transactions_owner_from_balance_idx";--> statement-breakpoint
DROP INDEX "transactions_owner_to_balance_idx";--> statement-breakpoint
CREATE INDEX "transactions_group_from_balance_idx" ON "transactions" USING btree ("group_id", "from_account_id", "occurred_at") INCLUDE ("amount_cents","counter_amount_cents","currency","counter_is_estimate") WHERE "group_id" is not null;--> statement-breakpoint
CREATE INDEX "transactions_group_to_balance_idx" ON "transactions" USING btree ("group_id", "to_account_id", "occurred_at") INCLUDE ("amount_cents","counter_amount_cents","currency","counter_is_estimate") WHERE "group_id" is not null;--> statement-breakpoint
CREATE INDEX "transactions_owner_from_balance_idx" ON "transactions" USING btree ("owner_user_id", "from_account_id", "occurred_at") INCLUDE ("amount_cents","counter_amount_cents","currency","counter_is_estimate") WHERE "owner_user_id" is not null;--> statement-breakpoint
CREATE INDEX "transactions_owner_to_balance_idx" ON "transactions" USING btree ("owner_user_id", "to_account_id", "occurred_at") INCLUDE ("amount_cents","counter_amount_cents","currency","counter_is_estimate") WHERE "owner_user_id" is not null;--> statement-breakpoint
-- One balance per account and currency (RF-121, RF-124): the key is `(id, currency)` and no surface
-- ever sums two of them. Still derived, never stored (RNF-07); still `security_invoker`, so the
-- movements stay behind the caller's own RLS. `currency` lands between the two columns the old view
-- returned, which `create or replace` cannot do, hence the drop and the grant below it.
DROP VIEW IF EXISTS public.account_balances;--> statement-breakpoint
create view account_balances with (security_invoker = on) as
  select s.id, s.currency, sum(s.amount_cents) as balance_cents
  from (
    -- The opening balance is one row, in the currency the account settles in (RF-121).
    select a.id, a.settlement_currency as currency, a.initial_balance_cents as amount_cents, true as is_settlement
      from public.accounts a
    union all
    -- Each side of a movement lands in the pocket it belongs to: its own currency while it is what
    -- was spent, the account's once a confirmed second amount says what it settled for. The other
    -- pocket takes a zero, so the move between the two nets out instead of leaving the amount in both.
    select t.to_account_id as id, v.currency, v.amount_cents, v.currency = a.settlement_currency
      from public.transactions t
      join public.accounts a on a.id = t.to_account_id
      cross join lateral (values
        (t.currency, case when t.currency <> a.settlement_currency and t.counter_amount_cents is not null and not t.counter_is_estimate then 0::bigint else t.amount_cents end),
        (a.settlement_currency, case when t.currency <> a.settlement_currency and t.counter_amount_cents is not null and not t.counter_is_estimate then t.counter_amount_cents else 0::bigint end)
      ) as v(currency, amount_cents)
     where t.to_account_id is not null
    union all
    select t.from_account_id as id, v.currency, -v.amount_cents, v.currency = a.settlement_currency
      from public.transactions t
      join public.accounts a on a.id = t.from_account_id
      cross join lateral (values
        (t.currency, case when t.currency <> a.settlement_currency and t.counter_amount_cents is not null and not t.counter_is_estimate then 0::bigint else t.amount_cents end),
        (a.settlement_currency, case when t.currency <> a.settlement_currency and t.counter_amount_cents is not null and not t.counter_is_estimate then t.counter_amount_cents else 0::bigint end)
      ) as v(currency, amount_cents)
     where t.from_account_id is not null
  ) s
  group by s.id, s.currency
  -- The list holds the currencies the account holds now: a pocket the statement settled back to zero
  -- is noise that grows with every currency ever touched, and the movements keep that history. The
  -- settlement currency is the exception and always answers, so a new account and an account spent
  -- back to zero both keep their row. `bool_or` reads the flag the legs already carry, so this is a
  -- HAVING over the same HashAggregate: it filters groups, never tuples, and the index-only scan
  -- underneath is untouched.
  having sum(s.amount_cents) <> 0 or bool_or(s.is_settlement);
--> statement-breakpoint
revoke all on account_balances from public, anon, authenticated, service_role;--> statement-breakpoint
grant select on account_balances to authenticated;
