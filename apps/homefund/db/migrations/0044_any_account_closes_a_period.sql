-- RF-129 and RF-130: the snapshot stops being a liability's and becomes any account's, and stops
-- inventing figures it calls captured. The table is renamed in place, so the twelve rows already
-- closed and their audit trail survive.
--
-- `interest_estimate_cents` is DROPPED and `interest_charged_cents` starts empty on every existing
-- row: the old column held what the app computed from the annual rate, not what an issuer charged.
-- Back-filling it would relabel an estimate as a captured figure, which is the exact conflation
-- RF-130 exists to end. A null reads "not recorded"; a zero would read "the bank charged nothing".
ALTER TABLE "debt_statements" RENAME TO "account_statements";--> statement-breakpoint
ALTER TABLE "account_statements" RENAME COLUMN "statement_balance_cents" TO "closing_balance_cents";--> statement-breakpoint
ALTER TABLE "account_statements" RENAME CONSTRAINT "debt_statements_pkey" TO "account_statements_pkey";--> statement-breakpoint
ALTER TABLE "account_statements" RENAME CONSTRAINT "debt_statements_account_id_accounts_id_fk" TO "account_statements_account_id_accounts_id_fk";--> statement-breakpoint
ALTER TABLE "account_statements" RENAME CONSTRAINT "debt_statements_account_cut_off_unique" TO "account_statements_account_cut_off_unique";--> statement-breakpoint
ALTER TABLE "account_statements" RENAME CONSTRAINT "debt_statements_period_before_cut_off" TO "account_statements_period_before_cut_off";--> statement-breakpoint

-- An asset statement demands no payment and prints no minimum, so both stop being mandatory and
-- their checks gain a null guard.
ALTER TABLE "account_statements" ALTER COLUMN "payment_due_date" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "account_statements" ALTER COLUMN "minimum_payment_cents" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "account_statements" DROP CONSTRAINT "debt_statements_due_after_cut_off";--> statement-breakpoint
ALTER TABLE "account_statements" DROP CONSTRAINT "debt_statements_minimum_non_negative";--> statement-breakpoint
ALTER TABLE "account_statements" DROP CONSTRAINT "debt_statements_interest_non_negative";--> statement-breakpoint
ALTER TABLE "account_statements" ADD CONSTRAINT "account_statements_due_after_cut_off" CHECK ("account_statements"."payment_due_date" is null or "account_statements"."payment_due_date" >= "account_statements"."cut_off_date");--> statement-breakpoint
ALTER TABLE "account_statements" ADD CONSTRAINT "account_statements_minimum_non_negative" CHECK ("account_statements"."minimum_payment_cents" is null or "account_statements"."minimum_payment_cents" >= 0);--> statement-breakpoint

ALTER TABLE "account_statements" DROP COLUMN "interest_estimate_cents";--> statement-breakpoint
-- All nullable: no institution prints all four, and a null says "not printed".
ALTER TABLE "account_statements" ADD COLUMN "opening_balance_cents" bigint;--> statement-breakpoint
ALTER TABLE "account_statements" ADD COLUMN "credits_cents" bigint;--> statement-breakpoint
ALTER TABLE "account_statements" ADD COLUMN "debits_cents" bigint;--> statement-breakpoint
ALTER TABLE "account_statements" ADD COLUMN "interest_charged_cents" bigint;--> statement-breakpoint
ALTER TABLE "account_statements" ADD COLUMN "fees_charged_cents" bigint;--> statement-breakpoint
ALTER TABLE "account_statements" ADD COLUMN "source" text DEFAULT 'recorded' NOT NULL;--> statement-breakpoint
ALTER TABLE "account_statements" ADD CONSTRAINT "account_statements_source_valid" CHECK ("account_statements"."source" in ('recorded', 'imported'));--> statement-breakpoint

-- The two policies travel with the table; only their names are stale. Shapes are untouched, and
-- there is still no UPDATE policy and no DELETE policy.
ALTER POLICY "debt_statements_select" ON "account_statements" RENAME TO "account_statements_select";--> statement-breakpoint
ALTER POLICY "debt_statements_insert" ON "account_statements" RENAME TO "account_statements_insert";--> statement-breakpoint

-- A statement is no longer a liability's alone (RF-129), so the guard that refused every other kind goes.
DROP TRIGGER "debt_statements_assert_liability" ON "account_statements";--> statement-breakpoint
DROP FUNCTION private.assert_debt_statement_liability();--> statement-breakpoint
DROP TRIGGER "capture_audit" ON "account_statements";--> statement-breakpoint
CREATE TRIGGER capture_audit AFTER INSERT OR UPDATE OR DELETE ON "account_statements"
  FOR EACH ROW EXECUTE FUNCTION private.capture_audit();--> statement-breakpoint

-- A rename does not rewrite a function body: this one still named the old table.
CREATE OR REPLACE FUNCTION private.hand_account_to_group(p_account uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
declare
  v_user uuid := (select auth.uid());
  v_group uuid;
  v_account public.accounts;
begin
  select m.group_id into v_group from public.group_members m
    where m.user_id = v_user and m.archived_at is null;
  if not found then
    raise exception 'the caller belongs to no group' using errcode = 'check_violation';
  end if;
  select * into v_account from public.accounts a
    where a.id = p_account and a.owner_user_id = v_user
    for update;
  if v_account.id is null then
    if exists (select 1 from public.accounts a where a.id = p_account and a.group_id = v_group) then
      raise exception 'account % already belongs to a group', p_account using errcode = 'check_violation';
    end if;
    raise exception 'account % is not the caller''s', p_account using errcode = 'check_violation';
  end if;
  if v_account.archived_at is not null then
    raise exception 'account % is archived', p_account using errcode = 'check_violation';
  end if;
  if exists (
    select 1 from public.transactions t
    where t.from_account_id = p_account or t.to_account_id = p_account
  ) or exists (
    select 1 from public.planned_payments p
    where p.from_account_id = p_account or p.to_account_id = p_account
  ) or exists (
    select 1 from public.recurring_rules r
    where r.from_account_id = p_account or r.to_account_id = p_account
  ) or exists (
    select 1 from public.budgets b where b.account_id = p_account
  ) or exists (
    select 1 from public.savings_goals g where g.account_id = p_account
  ) or exists (
    select 1 from public.installment_plans i where i.account_id = p_account
  ) or exists (
    select 1 from public.account_statements s where s.account_id = p_account
  ) or exists (
    select 1 from public.ingest_deliveries d where d.proposed_account_id = p_account
  ) or exists (
    select 1 from public.webhook_credentials w where w.default_account_id = p_account
  ) then
    raise exception 'account % carries history and is archived, not handed over', p_account using errcode = 'check_violation';
  end if;
  update public.accounts
    set owner_user_id = null, group_id = v_group, is_shared = true
    where id = p_account;
  return true;
end;
$$;--> statement-breakpoint

-- A rename carries the old grants forward, and `revoke all on table` leaves column privileges
-- standing, so both are revoked before the column form is re-granted. `authenticated` reads every
-- column and writes every one but `id` and `closed_at`, which the defaults fill.
REVOKE ALL ON TABLE "public"."account_statements" FROM anon, authenticated, service_role;--> statement-breakpoint
REVOKE ALL (id, account_id, period_start, cut_off_date, payment_due_date, opening_balance_cents, closing_balance_cents, credits_cents, debits_cents, minimum_payment_cents, interest_charged_cents, fees_charged_cents, source, closed_at) ON TABLE "public"."account_statements" FROM anon, authenticated, service_role;--> statement-breakpoint
GRANT SELECT (id, account_id, period_start, cut_off_date, payment_due_date, opening_balance_cents, closing_balance_cents, credits_cents, debits_cents, minimum_payment_cents, interest_charged_cents, fees_charged_cents, source, closed_at) ON TABLE "public"."account_statements" TO authenticated;--> statement-breakpoint
GRANT INSERT (account_id, period_start, cut_off_date, payment_due_date, opening_balance_cents, closing_balance_cents, credits_cents, debits_cents, minimum_payment_cents, interest_charged_cents, fees_charged_cents, source) ON TABLE "public"."account_statements" TO authenticated;
