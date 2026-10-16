CREATE TABLE "budgets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid,
	"group_id" uuid,
	"category_id" uuid NOT NULL,
	"account_id" uuid,
	"label_id" uuid,
	"period" text NOT NULL,
	"limit_cents" bigint NOT NULL,
	"threshold_pct" smallint NOT NULL,
	"name" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "budgets_limit_positive" CHECK ("budgets"."limit_cents" > 0),
	CONSTRAINT "budgets_threshold_pct_valid" CHECK ("budgets"."threshold_pct" between 1 and 100),
	CONSTRAINT "budgets_owner_xor_group" CHECK (num_nonnulls("budgets"."owner_user_id", "budgets"."group_id") = 1),
	CONSTRAINT "budgets_period_valid" CHECK ("budgets"."period" in ('monthly', 'weekly', 'yearly')),
	CONSTRAINT "budgets_name_length" CHECK ("budgets"."name" is null or length(btrim("budgets"."name")) <= 80)
);
--> statement-breakpoint
ALTER TABLE "budgets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "planned_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid,
	"group_id" uuid,
	"from_account_id" uuid,
	"to_account_id" uuid,
	"amount_cents" bigint NOT NULL,
	"category_id" uuid,
	"due_date" date NOT NULL,
	"remind_on" date,
	"description" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"settled_transaction_id" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "planned_payments_amount_positive" CHECK ("planned_payments"."amount_cents" > 0),
	CONSTRAINT "planned_payments_at_least_one_account" CHECK (num_nonnulls("planned_payments"."from_account_id", "planned_payments"."to_account_id") >= 1),
	CONSTRAINT "planned_payments_owner_xor_group" CHECK (num_nonnulls("planned_payments"."owner_user_id", "planned_payments"."group_id") = 1),
	CONSTRAINT "planned_payments_status_valid" CHECK ("planned_payments"."status" in ('pending', 'done', 'cancelled')),
	CONSTRAINT "planned_payments_remind_on_before_due" CHECK ("planned_payments"."remind_on" is null or "planned_payments"."remind_on" <= "planned_payments"."due_date"),
	CONSTRAINT "planned_payments_description_length" CHECK (length("planned_payments"."description") <= 200)
);
--> statement-breakpoint
ALTER TABLE "planned_payments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "savings_goals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid,
	"group_id" uuid,
	"name" text NOT NULL,
	"target_amount_cents" bigint NOT NULL,
	"target_date" date,
	"account_id" uuid,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "savings_goals_target_positive" CHECK ("savings_goals"."target_amount_cents" > 0),
	CONSTRAINT "savings_goals_owner_xor_group" CHECK (num_nonnulls("savings_goals"."owner_user_id", "savings_goals"."group_id") = 1),
	CONSTRAINT "savings_goals_name_length" CHECK (length(btrim("savings_goals"."name")) between 1 and 80)
);
--> statement-breakpoint
ALTER TABLE "savings_goals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "goal_contributions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"goal_id" uuid NOT NULL,
	"transaction_id" uuid NOT NULL,
	"amount_cents" bigint NOT NULL,
	CONSTRAINT "goal_contributions_goal_transaction_unique" UNIQUE("goal_id","transaction_id"),
	CONSTRAINT "goal_contributions_amount_positive" CHECK ("goal_contributions"."amount_cents" > 0)
);
--> statement-breakpoint
ALTER TABLE "goal_contributions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_owner_user_id_app_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_label_id_labels_id_fk" FOREIGN KEY ("label_id") REFERENCES "public"."labels"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planned_payments" ADD CONSTRAINT "planned_payments_owner_user_id_app_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."app_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planned_payments" ADD CONSTRAINT "planned_payments_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planned_payments" ADD CONSTRAINT "planned_payments_from_account_id_accounts_id_fk" FOREIGN KEY ("from_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planned_payments" ADD CONSTRAINT "planned_payments_to_account_id_accounts_id_fk" FOREIGN KEY ("to_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planned_payments" ADD CONSTRAINT "planned_payments_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planned_payments" ADD CONSTRAINT "planned_payments_settled_transaction_id_transactions_id_fk" FOREIGN KEY ("settled_transaction_id") REFERENCES "public"."transactions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planned_payments" ADD CONSTRAINT "planned_payments_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "savings_goals" ADD CONSTRAINT "savings_goals_owner_user_id_app_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "savings_goals" ADD CONSTRAINT "savings_goals_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "savings_goals" ADD CONSTRAINT "savings_goals_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_contributions" ADD CONSTRAINT "goal_contributions_goal_id_savings_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."savings_goals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_contributions" ADD CONSTRAINT "goal_contributions_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "budgets_owner_user_id_idx" ON "budgets" USING btree ("owner_user_id") WHERE "budgets"."owner_user_id" is not null;--> statement-breakpoint
CREATE INDEX "budgets_group_id_idx" ON "budgets" USING btree ("group_id") WHERE "budgets"."group_id" is not null;--> statement-breakpoint
CREATE INDEX "budgets_category_id_idx" ON "budgets" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "planned_payments_owner_user_id_idx" ON "planned_payments" USING btree ("owner_user_id") WHERE "planned_payments"."owner_user_id" is not null;--> statement-breakpoint
CREATE INDEX "planned_payments_group_id_idx" ON "planned_payments" USING btree ("group_id") WHERE "planned_payments"."group_id" is not null;--> statement-breakpoint
CREATE INDEX "planned_payments_due_date_idx" ON "planned_payments" USING btree ("due_date");--> statement-breakpoint
CREATE INDEX "planned_payments_settled_transaction_id_idx" ON "planned_payments" USING btree ("settled_transaction_id");--> statement-breakpoint
CREATE INDEX "savings_goals_owner_user_id_idx" ON "savings_goals" USING btree ("owner_user_id") WHERE "savings_goals"."owner_user_id" is not null;--> statement-breakpoint
CREATE INDEX "savings_goals_group_id_idx" ON "savings_goals" USING btree ("group_id") WHERE "savings_goals"."group_id" is not null;--> statement-breakpoint
CREATE INDEX "goal_contributions_goal_id_idx" ON "goal_contributions" USING btree ("goal_id");--> statement-breakpoint
CREATE INDEX "goal_contributions_transaction_id_idx" ON "goal_contributions" USING btree ("transaction_id");--> statement-breakpoint
CREATE POLICY "budgets_select_member" ON "budgets" AS PERMISSIVE FOR SELECT TO "authenticated" USING (((select auth.uid()) = "budgets"."owner_user_id" or (select private.is_group_member(coalesce("budgets"."group_id", private.owner_group_id("budgets"."owner_user_id"))))));--> statement-breakpoint
CREATE POLICY "budgets_insert_personal" ON "budgets" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ((select auth.uid()) = "budgets"."owner_user_id");--> statement-breakpoint
CREATE POLICY "budgets_insert_group" ON "budgets" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ((select private.is_group_member("budgets"."group_id")));--> statement-breakpoint
CREATE POLICY "budgets_update_personal" ON "budgets" AS PERMISSIVE FOR UPDATE TO "authenticated" USING ((select auth.uid()) = "budgets"."owner_user_id") WITH CHECK ((select auth.uid()) = "budgets"."owner_user_id");--> statement-breakpoint
CREATE POLICY "budgets_update_group" ON "budgets" AS PERMISSIVE FOR UPDATE TO "authenticated" USING ((select private.is_group_member("budgets"."group_id"))) WITH CHECK ((select private.is_group_member("budgets"."group_id")));--> statement-breakpoint
CREATE POLICY "budgets_delete_personal" ON "budgets" AS PERMISSIVE FOR DELETE TO "authenticated" USING ((select auth.uid()) = "budgets"."owner_user_id");--> statement-breakpoint
CREATE POLICY "budgets_delete_group" ON "budgets" AS PERMISSIVE FOR DELETE TO "authenticated" USING ((select private.is_group_member("budgets"."group_id")));--> statement-breakpoint
CREATE POLICY "planned_payments_select_member" ON "planned_payments" AS PERMISSIVE FOR SELECT TO "authenticated" USING (((select auth.uid()) = "planned_payments"."owner_user_id" or (select private.is_group_member(coalesce("planned_payments"."group_id", private.owner_group_id("planned_payments"."owner_user_id"))))));--> statement-breakpoint
CREATE POLICY "planned_payments_insert_writable" ON "planned_payments" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ((select private.can_write_transaction("planned_payments"."from_account_id", "planned_payments"."to_account_id")));--> statement-breakpoint
CREATE POLICY "planned_payments_update_writable" ON "planned_payments" AS PERMISSIVE FOR UPDATE TO "authenticated" USING ((select private.can_write_transaction("planned_payments"."from_account_id", "planned_payments"."to_account_id"))) WITH CHECK ((select private.can_write_transaction("planned_payments"."from_account_id", "planned_payments"."to_account_id")));--> statement-breakpoint
CREATE POLICY "planned_payments_delete_writable" ON "planned_payments" AS PERMISSIVE FOR DELETE TO "authenticated" USING ((select private.can_write_transaction("planned_payments"."from_account_id", "planned_payments"."to_account_id")));--> statement-breakpoint
CREATE POLICY "savings_goals_select_member" ON "savings_goals" AS PERMISSIVE FOR SELECT TO "authenticated" USING (((select auth.uid()) = "savings_goals"."owner_user_id" or (select private.is_group_member(coalesce("savings_goals"."group_id", private.owner_group_id("savings_goals"."owner_user_id"))))));--> statement-breakpoint
CREATE POLICY "savings_goals_insert_personal" ON "savings_goals" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ((select auth.uid()) = "savings_goals"."owner_user_id");--> statement-breakpoint
CREATE POLICY "savings_goals_insert_group" ON "savings_goals" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ((select private.is_group_member("savings_goals"."group_id")));--> statement-breakpoint
CREATE POLICY "savings_goals_update_personal" ON "savings_goals" AS PERMISSIVE FOR UPDATE TO "authenticated" USING ((select auth.uid()) = "savings_goals"."owner_user_id") WITH CHECK ((select auth.uid()) = "savings_goals"."owner_user_id");--> statement-breakpoint
CREATE POLICY "savings_goals_update_group" ON "savings_goals" AS PERMISSIVE FOR UPDATE TO "authenticated" USING ((select private.is_group_member("savings_goals"."group_id"))) WITH CHECK ((select private.is_group_member("savings_goals"."group_id")));--> statement-breakpoint
CREATE POLICY "savings_goals_delete_personal" ON "savings_goals" AS PERMISSIVE FOR DELETE TO "authenticated" USING ((select auth.uid()) = "savings_goals"."owner_user_id");--> statement-breakpoint
CREATE POLICY "savings_goals_delete_group" ON "savings_goals" AS PERMISSIVE FOR DELETE TO "authenticated" USING ((select private.is_group_member("savings_goals"."group_id")));--> statement-breakpoint
CREATE POLICY "goal_contributions_select_member" ON "goal_contributions" AS PERMISSIVE FOR SELECT TO "authenticated" USING (exists (select 1 from "savings_goals" g where g.id = "goal_contributions"."goal_id" and (g.owner_user_id = (select auth.uid()) or private.is_group_member(coalesce(g.group_id, private.owner_group_id(g.owner_user_id))))));--> statement-breakpoint
CREATE POLICY "goal_contributions_insert_member" ON "goal_contributions" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK (exists (select 1 from "savings_goals" g where g.id = "goal_contributions"."goal_id" and (g.owner_user_id = (select auth.uid()) or private.is_group_member(g.group_id))));--> statement-breakpoint
CREATE POLICY "goal_contributions_delete_member" ON "goal_contributions" AS PERMISSIVE FOR DELETE TO "authenticated" USING (exists (select 1 from "savings_goals" g where g.id = "goal_contributions"."goal_id" and (g.owner_user_id = (select auth.uid()) or private.is_group_member(g.group_id))));--> statement-breakpoint
-- The scope is derived, never chosen: any involved group account makes the whole payment group-scoped,
-- otherwise it is the caller's personal scope. `created_by` is stamped once, on insert (RF-74).
create or replace function private.set_planned_payment_scope() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_from_group uuid;
  v_to_group uuid;
begin
  select a.group_id into v_from_group from public.accounts a where a.id = new.from_account_id;
  select a.group_id into v_to_group from public.accounts a where a.id = new.to_account_id;
  if coalesce(v_from_group, v_to_group) is not null then
    new.group_id := coalesce(v_from_group, v_to_group);
    new.owner_user_id := null;
  else
    new.owner_user_id := (select auth.uid());
    new.group_id := null;
  end if;
  if tg_op = 'INSERT' then
    new.created_by := (select auth.uid());
  else
    -- A caller granted UPDATE still cannot rewrite who first planned the payment.
    new.created_by := old.created_by;
  end if;
  return new;
end;
$$;
revoke all on function private.set_planned_payment_scope() from public, anon, authenticated, service_role;--> statement-breakpoint
create or replace function private.assert_budget_scope() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  c public.categories;
  a public.accounts;
  l public.labels;
begin
  select * into c from public.categories where id = new.category_id;
  -- A budget caps spending, so it names an expense category (RF-71).
  if c.kind <> 'expense' then
    raise exception 'a budget names an expense category' using errcode = 'check_violation';
  end if;
  if c.owner_user_id is distinct from new.owner_user_id or c.group_id is distinct from new.group_id then
    raise exception 'a budget category must share the budget''s scope' using errcode = 'check_violation';
  end if;
  -- The optional account narrowing stays within the budget's own scope.
  if new.account_id is not null then
    select * into a from public.accounts where id = new.account_id;
    if a.owner_user_id is distinct from new.owner_user_id or a.group_id is distinct from new.group_id then
      raise exception 'a budget account must share the budget''s scope' using errcode = 'check_violation';
    end if;
  end if;
  -- The optional label narrowing stays within the budget's own scope.
  if new.label_id is not null then
    select * into l from public.labels where id = new.label_id;
    if l.owner_user_id is distinct from new.owner_user_id or l.group_id is distinct from new.group_id then
      raise exception 'a budget label must share the budget''s scope' using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function private.assert_budget_scope() from public, anon, authenticated, service_role;--> statement-breakpoint
create or replace function private.assert_goal_contribution_scope() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  g public.savings_goals;
  t public.transactions;
begin
  select * into g from public.savings_goals where id = new.goal_id;
  select * into t from public.transactions where id = new.transaction_id;
  -- A contribution earmarks a movement that shares the goal's scope (RF-77).
  if g.owner_user_id is distinct from t.owner_user_id or g.group_id is distinct from t.group_id then
    raise exception 'a contribution must share its goal''s scope' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
revoke all on function private.assert_goal_contribution_scope() from public, anon, authenticated, service_role;--> statement-breakpoint
create or replace function private.guard_planned_payment_settle() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  -- Once a payment points at the movement it settled into, that link is permanent (RF-75).
  if old.settled_transaction_id is not null
     and new.settled_transaction_id is distinct from old.settled_transaction_id then
    raise exception 'a settled payment cannot change its transaction' using errcode = 'check_violation';
  end if;
  -- 'done' and 'cancelled' are terminal: a payment never returns to pending.
  if old.status in ('done', 'cancelled') and new.status = 'pending' then
    raise exception 'a settled or cancelled payment cannot return to pending' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
revoke all on function private.guard_planned_payment_settle() from public, anon, authenticated, service_role;--> statement-breakpoint
ALTER TABLE "budgets" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "planned_payments" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "savings_goals" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "goal_contributions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "budgets" FROM anon, authenticated, service_role;--> statement-breakpoint
GRANT SELECT ON TABLE "budgets" TO authenticated;--> statement-breakpoint
GRANT INSERT (owner_user_id, group_id, category_id, account_id, label_id, period, limit_cents, threshold_pct, name) ON TABLE "budgets" TO authenticated;--> statement-breakpoint
GRANT UPDATE (account_id, label_id, period, limit_cents, threshold_pct, name, archived_at) ON TABLE "budgets" TO authenticated;--> statement-breakpoint
GRANT DELETE ON TABLE "budgets" TO authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "planned_payments" FROM anon, authenticated, service_role;--> statement-breakpoint
GRANT SELECT ON TABLE "planned_payments" TO authenticated;--> statement-breakpoint
GRANT INSERT (from_account_id, to_account_id, amount_cents, category_id, due_date, remind_on, description) ON TABLE "planned_payments" TO authenticated;--> statement-breakpoint
GRANT UPDATE (from_account_id, to_account_id, amount_cents, category_id, due_date, remind_on, description, status, settled_transaction_id) ON TABLE "planned_payments" TO authenticated;--> statement-breakpoint
GRANT DELETE ON TABLE "planned_payments" TO authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "savings_goals" FROM anon, authenticated, service_role;--> statement-breakpoint
GRANT SELECT ON TABLE "savings_goals" TO authenticated;--> statement-breakpoint
GRANT INSERT (owner_user_id, group_id, name, target_amount_cents, target_date, account_id) ON TABLE "savings_goals" TO authenticated;--> statement-breakpoint
GRANT UPDATE (name, target_amount_cents, target_date, account_id, archived_at) ON TABLE "savings_goals" TO authenticated;--> statement-breakpoint
GRANT DELETE ON TABLE "savings_goals" TO authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "goal_contributions" FROM anon, authenticated, service_role;--> statement-breakpoint
GRANT SELECT ON TABLE "goal_contributions" TO authenticated;--> statement-breakpoint
GRANT INSERT (goal_id, transaction_id, amount_cents) ON TABLE "goal_contributions" TO authenticated;--> statement-breakpoint
GRANT DELETE ON TABLE "goal_contributions" TO authenticated;--> statement-breakpoint
CREATE TRIGGER budgets_set_timestamps BEFORE INSERT OR UPDATE ON "budgets"
  FOR EACH ROW EXECUTE FUNCTION private.set_row_timestamps();--> statement-breakpoint
CREATE TRIGGER assert_budget_scope BEFORE INSERT OR UPDATE ON "budgets"
  FOR EACH ROW EXECUTE FUNCTION private.assert_budget_scope();--> statement-breakpoint
CREATE TRIGGER planned_payments_set_timestamps BEFORE INSERT OR UPDATE ON "planned_payments"
  FOR EACH ROW EXECUTE FUNCTION private.set_row_timestamps();--> statement-breakpoint
CREATE TRIGGER set_planned_payment_scope BEFORE INSERT OR UPDATE ON "planned_payments"
  FOR EACH ROW EXECUTE FUNCTION private.set_planned_payment_scope();--> statement-breakpoint
CREATE TRIGGER guard_planned_payment_settle BEFORE UPDATE ON "planned_payments"
  FOR EACH ROW EXECUTE FUNCTION private.guard_planned_payment_settle();--> statement-breakpoint
CREATE TRIGGER savings_goals_set_timestamps BEFORE INSERT OR UPDATE ON "savings_goals"
  FOR EACH ROW EXECUTE FUNCTION private.set_row_timestamps();--> statement-breakpoint
CREATE TRIGGER assert_goal_contribution_scope BEFORE INSERT OR UPDATE ON "goal_contributions"
  FOR EACH ROW EXECUTE FUNCTION private.assert_goal_contribution_scope();--> statement-breakpoint
-- Progress is derived from the earmarked movements, never stored (RF-77); `security_invoker` keeps
-- the contributions behind the caller's own RLS.
create view public.goal_progress with (security_invoker = on) as
  select g.id as goal_id,
    coalesce((select sum(gc.amount_cents) from public.goal_contributions gc where gc.goal_id = g.id), 0)::bigint as saved_cents
  from public.savings_goals g;
--> statement-breakpoint
revoke all on public.goal_progress from public, anon, service_role;--> statement-breakpoint
grant select on public.goal_progress to authenticated;