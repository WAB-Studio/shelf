CREATE TABLE "debt_terms" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"debt_kind" text NOT NULL,
	"annual_rate" numeric NOT NULL,
	"minimum_payment_cents" bigint,
	"minimum_payment_pct" numeric,
	"credit_limit_cents" bigint,
	"statement_cut_off_day" smallint,
	"payment_due_day" smallint,
	"aval_cents" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "debt_terms_kind_valid" CHECK ("debt_terms"."debt_kind" in ('revolving', 'installment')),
	CONSTRAINT "debt_terms_annual_rate_non_negative" CHECK ("debt_terms"."annual_rate" >= 0),
	CONSTRAINT "debt_terms_minimum_amount_xor_pct" CHECK (num_nonnulls("debt_terms"."minimum_payment_cents", "debt_terms"."minimum_payment_pct") <= 1),
	CONSTRAINT "debt_terms_minimum_payment_cents_non_negative" CHECK ("debt_terms"."minimum_payment_cents" is null or "debt_terms"."minimum_payment_cents" >= 0),
	CONSTRAINT "debt_terms_minimum_payment_pct_fraction" CHECK ("debt_terms"."minimum_payment_pct" is null or ("debt_terms"."minimum_payment_pct" >= 0 and "debt_terms"."minimum_payment_pct" <= 1)),
	CONSTRAINT "debt_terms_credit_limit_cents_non_negative" CHECK ("debt_terms"."credit_limit_cents" is null or "debt_terms"."credit_limit_cents" >= 0),
	CONSTRAINT "debt_terms_aval_cents_non_negative" CHECK ("debt_terms"."aval_cents" is null or "debt_terms"."aval_cents" >= 0),
	CONSTRAINT "debt_terms_statement_cut_off_day_valid" CHECK ("debt_terms"."statement_cut_off_day" is null or "debt_terms"."statement_cut_off_day" between 1 and 31),
	CONSTRAINT "debt_terms_payment_due_day_valid" CHECK ("debt_terms"."payment_due_day" is null or "debt_terms"."payment_due_day" between 1 and 31)
);
--> statement-breakpoint
ALTER TABLE "debt_terms" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "installment_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"description" text,
	"principal_cents" bigint NOT NULL,
	"n_installments" smallint NOT NULL,
	"frequency" text NOT NULL,
	"interest_rate" numeric,
	"down_payment_cents" bigint,
	"aval_cents" bigint,
	"start_date" date NOT NULL,
	"merchant" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "installment_plans_principal_positive" CHECK ("installment_plans"."principal_cents" > 0),
	CONSTRAINT "installment_plans_n_installments_positive" CHECK ("installment_plans"."n_installments" > 0),
	CONSTRAINT "installment_plans_frequency_valid" CHECK ("installment_plans"."frequency" in ('monthly', 'fortnightly')),
	CONSTRAINT "installment_plans_interest_rate_non_negative" CHECK ("installment_plans"."interest_rate" is null or "installment_plans"."interest_rate" >= 0),
	CONSTRAINT "installment_plans_down_payment_cents_non_negative" CHECK ("installment_plans"."down_payment_cents" is null or "installment_plans"."down_payment_cents" >= 0),
	CONSTRAINT "installment_plans_aval_cents_non_negative" CHECK ("installment_plans"."aval_cents" is null or "installment_plans"."aval_cents" >= 0),
	CONSTRAINT "installment_plans_description_length" CHECK (length("installment_plans"."description") <= 200),
	CONSTRAINT "installment_plans_merchant_length" CHECK (length("installment_plans"."merchant") <= 120)
);
--> statement-breakpoint
ALTER TABLE "installment_plans" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "installment_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_id" uuid NOT NULL,
	"seq" smallint NOT NULL,
	"due_date" date NOT NULL,
	"amount_cents" bigint NOT NULL,
	"paid_transaction_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "installment_lines_plan_seq_unique" UNIQUE("plan_id","seq"),
	CONSTRAINT "installment_lines_amount_positive" CHECK ("installment_lines"."amount_cents" > 0),
	CONSTRAINT "installment_lines_seq_positive" CHECK ("installment_lines"."seq" > 0)
);
--> statement-breakpoint
ALTER TABLE "installment_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "debt_statements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"period_start" date NOT NULL,
	"cut_off_date" date NOT NULL,
	"payment_due_date" date NOT NULL,
	"statement_balance_cents" bigint NOT NULL,
	"minimum_payment_cents" bigint NOT NULL,
	"interest_estimate_cents" bigint NOT NULL,
	"closed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "debt_statements_account_cut_off_unique" UNIQUE("account_id","cut_off_date"),
	CONSTRAINT "debt_statements_period_before_cut_off" CHECK ("debt_statements"."period_start" <= "debt_statements"."cut_off_date"),
	CONSTRAINT "debt_statements_due_after_cut_off" CHECK ("debt_statements"."payment_due_date" >= "debt_statements"."cut_off_date"),
	CONSTRAINT "debt_statements_minimum_non_negative" CHECK ("debt_statements"."minimum_payment_cents" >= 0),
	CONSTRAINT "debt_statements_interest_non_negative" CHECK ("debt_statements"."interest_estimate_cents" >= 0)
);
--> statement-breakpoint
ALTER TABLE "debt_statements" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "debt_terms" ADD CONSTRAINT "debt_terms_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "installment_plans" ADD CONSTRAINT "installment_plans_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "installment_lines" ADD CONSTRAINT "installment_lines_plan_id_installment_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."installment_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "installment_lines" ADD CONSTRAINT "installment_lines_paid_transaction_id_transactions_id_fk" FOREIGN KEY ("paid_transaction_id") REFERENCES "public"."transactions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debt_statements" ADD CONSTRAINT "debt_statements_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "installment_plans_account_id_idx" ON "installment_plans" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "installment_lines_plan_id_idx" ON "installment_lines" USING btree ("plan_id");--> statement-breakpoint
CREATE INDEX "installment_lines_paid_transaction_id_idx" ON "installment_lines" USING btree ("paid_transaction_id");--> statement-breakpoint
CREATE INDEX "installment_lines_plan_due_seq_idx" ON "installment_lines" USING btree ("plan_id","due_date","seq");--> statement-breakpoint
create or replace function private.can_read_account(uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  -- Mirrors the accounts SELECT predicate, for the debt rows that hang off an account.
  select exists (
    select 1 from public.accounts a
    where a.id = $1 and (
      a.owner_user_id = (select auth.uid())
      or private.is_group_member(coalesce(a.group_id, private.owner_group_id(a.owner_user_id)))
    )
  );
$$;--> statement-breakpoint
revoke all on function private.can_read_account(uuid) from public, anon, service_role;--> statement-breakpoint
grant execute on function private.can_read_account(uuid) to authenticated;--> statement-breakpoint
CREATE POLICY "debt_terms_select" ON "debt_terms" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((select private.can_read_account("debt_terms"."account_id")));--> statement-breakpoint
CREATE POLICY "debt_terms_insert" ON "debt_terms" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ((select private.can_write_account("debt_terms"."account_id")));--> statement-breakpoint
CREATE POLICY "debt_terms_update" ON "debt_terms" AS PERMISSIVE FOR UPDATE TO "authenticated" USING ((select private.can_write_account("debt_terms"."account_id"))) WITH CHECK ((select private.can_write_account("debt_terms"."account_id")));--> statement-breakpoint
CREATE POLICY "debt_terms_delete" ON "debt_terms" AS PERMISSIVE FOR DELETE TO "authenticated" USING ((select private.can_write_account("debt_terms"."account_id")));--> statement-breakpoint
CREATE POLICY "installment_plans_select" ON "installment_plans" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((select private.can_read_account("installment_plans"."account_id")));--> statement-breakpoint
CREATE POLICY "installment_plans_insert" ON "installment_plans" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ((select private.can_write_account("installment_plans"."account_id")));--> statement-breakpoint
CREATE POLICY "installment_plans_update" ON "installment_plans" AS PERMISSIVE FOR UPDATE TO "authenticated" USING ((select private.can_write_account("installment_plans"."account_id"))) WITH CHECK ((select private.can_write_account("installment_plans"."account_id")));--> statement-breakpoint
CREATE POLICY "installment_plans_delete" ON "installment_plans" AS PERMISSIVE FOR DELETE TO "authenticated" USING ((select private.can_write_account("installment_plans"."account_id")));--> statement-breakpoint
CREATE POLICY "installment_lines_select" ON "installment_lines" AS PERMISSIVE FOR SELECT TO "authenticated" USING (exists (select 1 from "installment_plans" p where p.id = "installment_lines"."plan_id" and private.can_read_account(p.account_id)));--> statement-breakpoint
CREATE POLICY "installment_lines_insert" ON "installment_lines" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK (exists (select 1 from "installment_plans" p where p.id = "installment_lines"."plan_id" and private.can_write_account(p.account_id)));--> statement-breakpoint
CREATE POLICY "installment_lines_update" ON "installment_lines" AS PERMISSIVE FOR UPDATE TO "authenticated" USING (exists (select 1 from "installment_plans" p where p.id = "installment_lines"."plan_id" and private.can_write_account(p.account_id))) WITH CHECK (exists (select 1 from "installment_plans" p where p.id = "installment_lines"."plan_id" and private.can_write_account(p.account_id)));--> statement-breakpoint
CREATE POLICY "installment_lines_delete" ON "installment_lines" AS PERMISSIVE FOR DELETE TO "authenticated" USING (exists (select 1 from "installment_plans" p where p.id = "installment_lines"."plan_id" and private.can_write_account(p.account_id)));--> statement-breakpoint
CREATE POLICY "debt_statements_select" ON "debt_statements" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((select private.can_read_account("debt_statements"."account_id")));--> statement-breakpoint
CREATE POLICY "debt_statements_insert" ON "debt_statements" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ((select private.can_write_account("debt_statements"."account_id")));--> statement-breakpoint
CREATE POLICY "debt_statements_delete" ON "debt_statements" AS PERMISSIVE FOR DELETE TO "authenticated" USING ((select private.can_write_account("debt_statements"."account_id")));--> statement-breakpoint
create or replace function private.assert_debt_terms_liability() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  a public.accounts;
begin
  select * into a from public.accounts where id = new.account_id;
  -- A debt profile only fits a liability account (RF-78).
  if a.kind <> 'liability' then
    raise exception 'debt terms attach to a liability account' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function private.assert_debt_terms_liability() from public, anon, authenticated, service_role;--> statement-breakpoint
create or replace function private.assert_installment_plan_account() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  a public.accounts;
begin
  select * into a from public.accounts where id = new.account_id;
  -- A plan schedules a liability's balance; it never attaches to an asset (RF-81).
  if a.kind <> 'liability' then
    raise exception 'an installment plan attaches to a liability account' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function private.assert_installment_plan_account() from public, anon, authenticated, service_role;--> statement-breakpoint
create or replace function private.assert_installment_line_payment() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  p public.installment_plans;
  t public.transactions;
begin
  -- Only a linked settlement is guarded; the allocator lives in the app layer (RF-82).
  if new.paid_transaction_id is null then return new; end if;
  select * into p from public.installment_plans where id = new.plan_id;
  select * into t from public.transactions where id = new.paid_transaction_id;
  -- The settling movement must touch the plan's own account.
  if t.from_account_id is distinct from p.account_id and t.to_account_id is distinct from p.account_id then
    raise exception 'a settling movement must touch the plan account' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function private.assert_installment_line_payment() from public, anon, authenticated, service_role;--> statement-breakpoint
create or replace function private.assert_debt_statement_liability() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  a public.accounts;
begin
  select * into a from public.accounts where id = new.account_id;
  -- A statement snapshots a liability's cut-off; assets carry none (RF-84).
  if a.kind <> 'liability' then
    raise exception 'a debt statement belongs to a liability account' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function private.assert_debt_statement_liability() from public, anon, authenticated, service_role;--> statement-breakpoint
ALTER TABLE "debt_terms" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "installment_plans" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "installment_lines" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "debt_statements" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "debt_terms" FROM anon, authenticated, service_role;--> statement-breakpoint
GRANT SELECT, DELETE ON TABLE "debt_terms" TO authenticated;--> statement-breakpoint
GRANT INSERT (account_id, debt_kind, annual_rate, minimum_payment_cents, minimum_payment_pct, credit_limit_cents, statement_cut_off_day, payment_due_day, aval_cents) ON TABLE "debt_terms" TO authenticated;--> statement-breakpoint
GRANT UPDATE (debt_kind, annual_rate, minimum_payment_cents, minimum_payment_pct, credit_limit_cents, statement_cut_off_day, payment_due_day, aval_cents) ON TABLE "debt_terms" TO authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "installment_plans" FROM anon, authenticated, service_role;--> statement-breakpoint
GRANT SELECT, DELETE ON TABLE "installment_plans" TO authenticated;--> statement-breakpoint
GRANT INSERT (account_id, description, principal_cents, n_installments, frequency, interest_rate, down_payment_cents, aval_cents, start_date, merchant) ON TABLE "installment_plans" TO authenticated;--> statement-breakpoint
GRANT UPDATE (description, merchant) ON TABLE "installment_plans" TO authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "installment_lines" FROM anon, authenticated, service_role;--> statement-breakpoint
GRANT SELECT, DELETE ON TABLE "installment_lines" TO authenticated;--> statement-breakpoint
GRANT INSERT (plan_id, seq, due_date, amount_cents) ON TABLE "installment_lines" TO authenticated;--> statement-breakpoint
GRANT UPDATE (paid_transaction_id) ON TABLE "installment_lines" TO authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "debt_statements" FROM anon, authenticated, service_role;--> statement-breakpoint
GRANT SELECT, DELETE ON TABLE "debt_statements" TO authenticated;--> statement-breakpoint
GRANT INSERT (account_id, period_start, cut_off_date, payment_due_date, statement_balance_cents, minimum_payment_cents, interest_estimate_cents) ON TABLE "debt_statements" TO authenticated;--> statement-breakpoint
CREATE TRIGGER debt_terms_set_timestamps BEFORE INSERT OR UPDATE ON "debt_terms"
  FOR EACH ROW EXECUTE FUNCTION private.set_row_timestamps();--> statement-breakpoint
CREATE TRIGGER debt_terms_assert_liability BEFORE INSERT OR UPDATE ON "debt_terms"
  FOR EACH ROW EXECUTE FUNCTION private.assert_debt_terms_liability();--> statement-breakpoint
CREATE TRIGGER installment_plans_set_timestamps BEFORE INSERT OR UPDATE ON "installment_plans"
  FOR EACH ROW EXECUTE FUNCTION private.set_row_timestamps();--> statement-breakpoint
CREATE TRIGGER installment_plans_assert_account BEFORE INSERT OR UPDATE ON "installment_plans"
  FOR EACH ROW EXECUTE FUNCTION private.assert_installment_plan_account();--> statement-breakpoint
CREATE TRIGGER installment_lines_assert_payment BEFORE INSERT OR UPDATE ON "installment_lines"
  FOR EACH ROW EXECUTE FUNCTION private.assert_installment_line_payment();--> statement-breakpoint
CREATE TRIGGER debt_statements_assert_liability BEFORE INSERT ON "debt_statements"
  FOR EACH ROW EXECUTE FUNCTION private.assert_debt_statement_liability();