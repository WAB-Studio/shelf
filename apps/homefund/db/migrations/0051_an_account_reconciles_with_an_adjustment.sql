-- RF-137 and RF-138: a person counts what an account really holds on a day, and the database books
-- the gap against the ledger as one marked, one-legged movement in the same statement. `kind` still
-- derives from the legs; the mark is what reports read to keep the adjustment out of every income,
-- expense and budget figure.
CREATE TABLE "finances"."account_reconciliations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"reconciled_on" date NOT NULL,
	"counted_balance_cents" bigint NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "finances"."account_reconciliations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "finances"."transactions" ADD COLUMN "reconciliation_id" uuid;--> statement-breakpoint
ALTER TABLE "finances"."account_reconciliations" ADD CONSTRAINT "account_reconciliations_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "finances"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finances"."account_reconciliations" ADD CONSTRAINT "account_reconciliations_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "finances"."app_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_reconciliations_account_day_idx" ON "finances"."account_reconciliations" USING btree ("account_id","reconciled_on" DESC NULLS LAST,"created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "account_reconciliations_created_by_idx" ON "finances"."account_reconciliations" USING btree ("created_by");--> statement-breakpoint
ALTER TABLE "finances"."transactions" ADD CONSTRAINT "transactions_reconciliation_id_account_reconciliations_id_fk" FOREIGN KEY ("reconciliation_id") REFERENCES "finances"."account_reconciliations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "transactions_reconciliation_id_unique" ON "finances"."transactions" USING btree ("reconciliation_id") WHERE "finances"."transactions"."reconciliation_id" is not null;--> statement-breakpoint
ALTER TABLE "finances"."transactions" ADD CONSTRAINT "transactions_adjustment_one_leg" CHECK ("finances"."transactions"."reconciliation_id" is null or (num_nonnulls("finances"."transactions"."from_account_id", "finances"."transactions"."to_account_id") = 1 and "finances"."transactions"."counter_amount_cents" is null));--> statement-breakpoint
CREATE POLICY "account_reconciliations_select" ON "finances"."account_reconciliations" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((select private.can_read_account("finances"."account_reconciliations"."account_id")));--> statement-breakpoint
CREATE POLICY "account_reconciliations_insert" ON "finances"."account_reconciliations" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ((select private.can_write_account("finances"."account_reconciliations"."account_id")));--> statement-breakpoint
ALTER POLICY "transactions_update_writable" ON "finances"."transactions" TO authenticated USING ((select private.can_write_transaction("finances"."transactions"."from_account_id", "finances"."transactions"."to_account_id")) and "finances"."transactions"."reconciliation_id" is null) WITH CHECK ((select private.can_write_transaction("finances"."transactions"."from_account_id", "finances"."transactions"."to_account_id")));--> statement-breakpoint
ALTER POLICY "transactions_delete_writable" ON "finances"."transactions" TO authenticated USING ((select private.can_write_transaction("finances"."transactions"."from_account_id", "finances"."transactions"."to_account_id")) and "finances"."transactions"."reconciliation_id" is null);--> statement-breakpoint
ALTER TABLE "finances"."account_reconciliations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- Supabase grants anon/authenticated/service_role at CREATE TABLE; every one of the three is revoked
-- before `authenticated` is re-granted, column by column. No UPDATE, no DELETE: a reconciliation is final.
REVOKE ALL ON TABLE "finances"."account_reconciliations" FROM public, anon, authenticated, service_role;--> statement-breakpoint
GRANT SELECT ON TABLE "finances"."account_reconciliations" TO authenticated;--> statement-breakpoint
GRANT INSERT (account_id, reconciled_on, counted_balance_cents) ON TABLE "finances"."account_reconciliations" TO authenticated;--> statement-breakpoint
CREATE TRIGGER capture_audit AFTER INSERT OR UPDATE OR DELETE ON "finances"."account_reconciliations"
  FOR EACH ROW EXECUTE FUNCTION private.capture_audit();--> statement-breakpoint
-- An account's balance on a day in its settlement currency, the way `account_balances` lands each leg
-- (RF-121, RF-124): its own amount in that currency, a confirmed second amount when spent in another,
-- nothing while that figure is an estimate. Invoker rights: a caller sums only the movements it reads.
CREATE OR REPLACE FUNCTION private.account_settlement_balance_on(p_account uuid, p_day date)
 RETURNS bigint
 LANGUAGE sql
 STABLE SECURITY INVOKER
 SET search_path TO ''
AS $function$
  select (a.initial_balance_cents
    + coalesce((select sum(case
        when t.currency = a.settlement_currency then t.amount_cents
        when t.counter_amount_cents is not null and not t.counter_is_estimate then t.counter_amount_cents
        else 0
      end) from finances.transactions t
      where t.to_account_id = a.id and t.occurred_at <= p_day), 0)
    - coalesce((select sum(case
        when t.currency = a.settlement_currency then t.amount_cents
        when t.counter_amount_cents is not null and not t.counter_is_estimate then t.counter_amount_cents
        else 0
      end) from finances.transactions t
      where t.from_account_id = a.id and t.occurred_at <= p_day), 0))::bigint
  from finances.accounts a
  where a.id = p_account;
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION private.account_settlement_balance_on(uuid, date) FROM public, anon, service_role;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION private.account_settlement_balance_on(uuid, date) TO authenticated;--> statement-breakpoint
CREATE OR REPLACE FUNCTION private.assert_account_reconciliation()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_account finances.accounts;
  v_latest date;
begin
  -- An owner-role write with no settled claim keeps the actor it named, as the movement triggers do.
  if (select auth.uid()) is not null then
    new.created_by := (select auth.uid());
  end if;
  -- An account the caller cannot write is left to the insert policy, so no refusal below tells a
  -- stranger anything about it, and no stranger locks it.
  if (select auth.uid()) is not null and not private.can_write_account(new.account_id) then
    return new;
  end if;
  -- The row lock serialises two reconciliations of one account, so neither books a gap against a
  -- ledger the other is about to move, and the latest day below cannot slip past either.
  select * into v_account from finances.accounts where id = new.account_id for no key update;
  if not found then
    return new;
  end if;
  if new.reconciled_on > (pg_catalog.now() at time zone 'America/Bogota')::date then
    raise exception 'a reconciliation cannot count a day that has not come' using errcode = 'RC001';
  end if;
  if new.reconciled_on < v_account.initial_balance_on then
    raise exception 'a reconciliation cannot predate the account''s opening balance' using errcode = 'RC002';
  end if;
  select max(r.reconciled_on) into v_latest
    from finances.account_reconciliations r where r.account_id = new.account_id;
  if v_latest is not null and new.reconciled_on < v_latest then
    raise exception 'a reconciliation cannot predate the account''s latest one' using errcode = 'RC003';
  end if;
  if v_account.archived_at is not null then
    raise exception 'an archived account is not reconciled' using errcode = 'RC004';
  end if;
  return new;
end;
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION private.assert_account_reconciliation() FROM public, anon, authenticated, service_role;--> statement-breakpoint
CREATE TRIGGER account_reconciliations_assert BEFORE INSERT ON "finances"."account_reconciliations"
  FOR EACH ROW EXECUTE FUNCTION private.assert_account_reconciliation();--> statement-breakpoint
-- Books the gap. Definer rights: the reconciliation's own insert policy already decided who may write
-- the account, and no grant lets a caller name `reconciliation_id`. Scope, `created_by` and audit
-- come from the movement's own triggers; the scope named here holds only for a claimless owner write.
CREATE OR REPLACE FUNCTION private.book_reconciliation_adjustment()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_account finances.accounts;
  v_gap bigint;
begin
  select * into v_account from finances.accounts where id = new.account_id;
  v_gap := new.counted_balance_cents - private.account_settlement_balance_on(new.account_id, new.reconciled_on);
  if v_gap = 0 then
    return null;
  end if;
  insert into finances.transactions
    (owner_user_id, group_id, from_account_id, to_account_id, amount_cents, currency,
     occurred_at, description, reconciliation_id, created_by)
  values
    (v_account.owner_user_id, v_account.group_id,
     case when v_gap < 0 then new.account_id end,
     case when v_gap > 0 then new.account_id end,
     abs(v_gap), v_account.settlement_currency,
     new.reconciled_on, null, new.id, new.created_by);
  return null;
end;
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION private.book_reconciliation_adjustment() FROM public, anon, authenticated, service_role;--> statement-breakpoint
CREATE TRIGGER account_reconciliations_book_adjustment AFTER INSERT ON "finances"."account_reconciliations"
  FOR EACH ROW EXECUTE FUNCTION private.book_reconciliation_adjustment();--> statement-breakpoint
-- An adjustment is the one income or expense with no split: budgets and the category breakdown sum
-- splits, so they never see it (RF-138).
CREATE OR REPLACE FUNCTION private.assert_transaction_splits_sum()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_txn_id uuid;
  t finances.transactions;
  v_sum bigint;
  v_count bigint;
begin
  if tg_table_name = 'transactions' then
    v_txn_id := new.id;
  else
    v_txn_id := coalesce(new.transaction_id, old.transaction_id);
  end if;
  -- The parent may have gone with a cascade delete: nothing left to reconcile.
  select * into t from finances.transactions where id = v_txn_id;
  if not found then return null; end if;
  select coalesce(sum(amount_cents), 0), count(*) into v_sum, v_count
    from finances.transaction_splits where transaction_id = v_txn_id;
  if t.kind = 'transfer' or t.reconciliation_id is not null then
    if v_count > 0 then
      raise exception 'a transfer or a reconciliation adjustment carries no split' using errcode = 'check_violation';
    end if;
  else
    if v_count = 0 then
      raise exception 'an income or expense needs at least one split' using errcode = 'check_violation';
    end if;
    if v_sum <> t.amount_cents then
      raise exception 'the splits must sum to the movement amount' using errcode = 'check_violation';
    end if;
  end if;
  return null;
end;
$function$;
