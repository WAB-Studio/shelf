CREATE TABLE "recurring_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid,
	"group_id" uuid,
	"from_account_id" uuid,
	"to_account_id" uuid,
	"amount_cents" bigint NOT NULL,
	"category_id" uuid NOT NULL,
	"description" text,
	"frequency" text NOT NULL,
	"interval_n" smallint NOT NULL,
	"day_of_month" smallint,
	"next_run_on" date NOT NULL,
	"ends_on" date,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recurring_rules_amount_positive" CHECK ("recurring_rules"."amount_cents" > 0),
	CONSTRAINT "recurring_rules_exactly_one_account" CHECK (num_nonnulls("recurring_rules"."from_account_id", "recurring_rules"."to_account_id") = 1),
	CONSTRAINT "recurring_rules_owner_xor_group" CHECK (num_nonnulls("recurring_rules"."owner_user_id", "recurring_rules"."group_id") = 1),
	CONSTRAINT "recurring_rules_frequency_valid" CHECK ("recurring_rules"."frequency" in ('monthly', 'weekly', 'yearly')),
	CONSTRAINT "recurring_rules_interval_positive" CHECK ("recurring_rules"."interval_n" >= 1),
	CONSTRAINT "recurring_rules_day_of_month_range" CHECK ("recurring_rules"."day_of_month" is null or "recurring_rules"."day_of_month" between 1 and 31),
	CONSTRAINT "recurring_rules_day_of_month_by_frequency" CHECK (case when "recurring_rules"."frequency" = 'weekly' then "recurring_rules"."day_of_month" is null else "recurring_rules"."day_of_month" is not null end),
	CONSTRAINT "recurring_rules_ends_on_after_next_run" CHECK ("recurring_rules"."ends_on" is null or "recurring_rules"."ends_on" >= "recurring_rules"."next_run_on"),
	CONSTRAINT "recurring_rules_description_length" CHECK (length("recurring_rules"."description") <= 200)
);
--> statement-breakpoint
ALTER TABLE "recurring_rules" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "recurring_rule_id" uuid;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "recurring_rules" ADD CONSTRAINT "recurring_rules_owner_user_id_app_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."app_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_rules" ADD CONSTRAINT "recurring_rules_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_rules" ADD CONSTRAINT "recurring_rules_from_account_id_accounts_id_fk" FOREIGN KEY ("from_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_rules" ADD CONSTRAINT "recurring_rules_to_account_id_accounts_id_fk" FOREIGN KEY ("to_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_rules" ADD CONSTRAINT "recurring_rules_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_rules" ADD CONSTRAINT "recurring_rules_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "recurring_rules_owner_user_id_idx" ON "recurring_rules" USING btree ("owner_user_id") WHERE "recurring_rules"."owner_user_id" is not null;--> statement-breakpoint
CREATE INDEX "recurring_rules_group_id_idx" ON "recurring_rules" USING btree ("group_id") WHERE "recurring_rules"."group_id" is not null;--> statement-breakpoint
CREATE INDEX "recurring_rules_next_run_on_idx" ON "recurring_rules" USING btree ("next_run_on");--> statement-breakpoint
CREATE INDEX "recurring_rules_category_id_idx" ON "recurring_rules" USING btree ("category_id");--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_recurring_rule_id_recurring_rules_id_fk" FOREIGN KEY ("recurring_rule_id") REFERENCES "public"."recurring_rules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "transactions_recurring_rule_id_idx" ON "transactions" USING btree ("recurring_rule_id");--> statement-breakpoint
CREATE POLICY "recurring_rules_select_member" ON "recurring_rules" AS PERMISSIVE FOR SELECT TO "authenticated" USING (((select auth.uid()) = "recurring_rules"."owner_user_id" or (select private.is_group_member(coalesce("recurring_rules"."group_id", private.owner_group_id("recurring_rules"."owner_user_id"))))));--> statement-breakpoint
CREATE POLICY "recurring_rules_insert_writable" ON "recurring_rules" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ((select private.can_write_transaction("recurring_rules"."from_account_id", "recurring_rules"."to_account_id")));--> statement-breakpoint
CREATE POLICY "recurring_rules_update_writable" ON "recurring_rules" AS PERMISSIVE FOR UPDATE TO "authenticated" USING ((select private.can_write_transaction("recurring_rules"."from_account_id", "recurring_rules"."to_account_id"))) WITH CHECK ((select private.can_write_transaction("recurring_rules"."from_account_id", "recurring_rules"."to_account_id")));--> statement-breakpoint
CREATE POLICY "recurring_rules_delete_writable" ON "recurring_rules" AS PERMISSIVE FOR DELETE TO "authenticated" USING ((select private.can_write_transaction("recurring_rules"."from_account_id", "recurring_rules"."to_account_id")));--> statement-breakpoint
-- The scope is derived, never chosen: the rule's single account decides whether it is group or
-- personal, and `created_by` is stamped once, on insert (RF-29). The daily generator writes with no
-- JWT, so it trusts the scope and author the rule already carries rather than blanking them.
create or replace function private.set_recurring_rule_scope() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_from_group uuid;
  v_to_group uuid;
begin
  if (select auth.uid()) is null then
    return new;
  end if;
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
    -- A caller granted UPDATE still cannot rewrite who first recorded the rule.
    new.created_by := old.created_by;
  end if;
  return new;
end;
$$;
revoke all on function private.set_recurring_rule_scope() from public, anon, authenticated, service_role;--> statement-breakpoint
-- Re-created with a system branch: the daily generator runs with no JWT, so a null `auth.uid()` means
-- trust the scope and author already on the row. The authenticated path below is unchanged.
create or replace function private.set_transaction_scope() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_from_group uuid;
  v_to_group uuid;
begin
  if (select auth.uid()) is null then
    return new;
  end if;
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
    -- A caller granted UPDATE still cannot rewrite who first recorded the movement.
    new.created_by := old.created_by;
  end if;
  return new;
end;
$$;
revoke all on function private.set_transaction_scope() from public, anon, authenticated, service_role;--> statement-breakpoint
-- Turns every due rule into real transactions in one transaction (RF-30). The owner runs it, bypassing
-- RLS; each missed period is back-filled at its own past date, marked with the rule and left unreviewed.
create or replace function private.run_due_recurring_rules() returns void
language plpgsql security definer set search_path = '' as $$
declare
  r public.recurring_rules;
  v_today date := (now() at time zone 'America/Bogota')::date;
  v_next date;
  v_active boolean;
  v_txn_id uuid;
  v_month_first date;
  v_days_in_month int;
  v_year int;
  v_month int;
begin
  for r in
    select * from public.recurring_rules
    where is_active and next_run_on <= v_today
  loop
    v_next := r.next_run_on;
    v_active := true;
    -- Back-fill every period the rule missed, each dated its own real past day.
    while v_next <= v_today loop
      -- The rule holds its single account on the matching side, so from/to copy straight over and the
      -- generated `kind` follows; the scope, author and rule link are the rule's own.
      insert into public.transactions
        (owner_user_id, group_id, from_account_id, to_account_id, amount_cents,
         occurred_at, description, recurring_rule_id, reviewed_at, created_by)
      values
        (r.owner_user_id, r.group_id, r.from_account_id, r.to_account_id, r.amount_cents,
         v_next, r.description, r.id, null, r.created_by)
      returning id into v_txn_id;
      -- Every rule is one-sided income or expense, so it always lands exactly one split.
      insert into public.transaction_splits (transaction_id, category_id, amount_cents)
        values (v_txn_id, r.category_id, r.amount_cents);
      -- Advance off the anchor, never off a clamped date: a day-31 rule yields Feb 28/29 then Mar 31.
      if r.frequency = 'weekly' then
        v_next := v_next + (7 * r.interval_n);
      elsif r.frequency = 'monthly' then
        v_month_first := (date_trunc('month', v_next::timestamp)
          + make_interval(months => r.interval_n))::date;
        v_days_in_month := extract(day from
          (v_month_first + interval '1 month' - interval '1 day'))::int;
        v_next := v_month_first + (least(r.day_of_month, v_days_in_month) - 1);
      else
        v_year := extract(year from v_next)::int + r.interval_n;
        v_month := extract(month from v_next)::int;
        v_days_in_month := extract(day from
          (make_date(v_year, v_month, 1) + interval '1 month' - interval '1 day'))::int;
        v_next := make_date(v_year, v_month, least(r.day_of_month, v_days_in_month));
      end if;
      -- Once the advanced date clears the end, the rule has run its course.
      if r.ends_on is not null and v_next > r.ends_on then
        v_active := false;
        exit;
      end if;
    end loop;
    update public.recurring_rules
      set next_run_on = v_next, is_active = v_active
      where id = r.id;
  end loop;
end;
$$;
revoke all on function private.run_due_recurring_rules() from public, anon, authenticated, service_role;--> statement-breakpoint
ALTER TABLE "recurring_rules" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "recurring_rules" FROM anon, authenticated, service_role;--> statement-breakpoint
GRANT SELECT ON TABLE "recurring_rules" TO authenticated;--> statement-breakpoint
GRANT INSERT (from_account_id, to_account_id, amount_cents, category_id, description, frequency, interval_n, day_of_month, next_run_on, ends_on) ON TABLE "recurring_rules" TO authenticated;--> statement-breakpoint
GRANT UPDATE (from_account_id, to_account_id, amount_cents, category_id, description, frequency, interval_n, day_of_month, next_run_on, ends_on, is_active) ON TABLE "recurring_rules" TO authenticated;--> statement-breakpoint
GRANT DELETE ON TABLE "recurring_rules" TO authenticated;--> statement-breakpoint
-- The generator leaves `reviewed_at` null; the caller stamps it when they confirm the movement (RF-31).
-- A separate column grant, narrower than 0001's UPDATE: RLS still bounds which rows can be touched.
GRANT UPDATE (reviewed_at) ON TABLE "transactions" TO authenticated;--> statement-breakpoint
CREATE TRIGGER recurring_rules_set_timestamps BEFORE INSERT OR UPDATE ON "recurring_rules"
  FOR EACH ROW EXECUTE FUNCTION private.set_row_timestamps();--> statement-breakpoint
CREATE TRIGGER set_recurring_rule_scope BEFORE INSERT OR UPDATE ON "recurring_rules"
  FOR EACH ROW EXECUTE FUNCTION private.set_recurring_rule_scope();--> statement-breakpoint
-- Scheduled work runs inside the database, not as an external task (SPEC §3): a daily job applies the
-- due rules just after the Bogotá midnight, so each period lands the moment its date has come.
create extension if not exists pg_cron;--> statement-breakpoint
select cron.unschedule(jobid) from cron.job where jobname = 'run-due-recurring-rules';--> statement-breakpoint
select cron.schedule('run-due-recurring-rules', '15 5 * * *', $$select private.run_due_recurring_rules()$$);