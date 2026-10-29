CREATE TABLE "transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid,
	"group_id" uuid,
	"from_account_id" uuid,
	"to_account_id" uuid,
	"amount_cents" bigint NOT NULL,
	"kind" text GENERATED ALWAYS AS (case when from_account_id is null then 'income' when to_account_id is null then 'expense' else 'transfer' end) STORED,
	"occurred_at" date NOT NULL,
	"description" text,
	"external_ref" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transactions_amount_positive" CHECK ("transactions"."amount_cents" > 0),
	CONSTRAINT "transactions_at_least_one_account" CHECK (num_nonnulls("transactions"."from_account_id", "transactions"."to_account_id") >= 1),
	CONSTRAINT "transactions_owner_xor_group" CHECK (("transactions"."owner_user_id" is not null)::int + ("transactions"."group_id" is not null)::int = 1),
	CONSTRAINT "transactions_description_length" CHECK (length("transactions"."description") <= 200),
	CONSTRAINT "transactions_external_ref_length" CHECK (length("transactions"."external_ref") <= 200)
);
--> statement-breakpoint
ALTER TABLE "transactions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "transaction_splits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transaction_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"amount_cents" bigint NOT NULL,
	CONSTRAINT "transaction_splits_amount_positive" CHECK ("transaction_splits"."amount_cents" > 0)
);
--> statement-breakpoint
CREATE TABLE "labels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid,
	"group_id" uuid,
	"name" text NOT NULL,
	"color" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "labels_name_length" CHECK (length(btrim("labels"."name")) between 1 and 80),
	CONSTRAINT "labels_owner_xor_group" CHECK (num_nonnulls("labels"."owner_user_id", "labels"."group_id") = 1)
);
--> statement-breakpoint
ALTER TABLE "labels" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "transaction_labels" (
	"transaction_id" uuid NOT NULL,
	"label_id" uuid NOT NULL,
	CONSTRAINT "transaction_labels_transaction_id_label_id_pk" PRIMARY KEY("transaction_id","label_id")
);
--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_owner_user_id_app_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."app_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_from_account_id_accounts_id_fk" FOREIGN KEY ("from_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_to_account_id_accounts_id_fk" FOREIGN KEY ("to_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_splits" ADD CONSTRAINT "transaction_splits_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_splits" ADD CONSTRAINT "transaction_splits_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "labels" ADD CONSTRAINT "labels_owner_user_id_app_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "labels" ADD CONSTRAINT "labels_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_labels" ADD CONSTRAINT "transaction_labels_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_labels" ADD CONSTRAINT "transaction_labels_label_id_labels_id_fk" FOREIGN KEY ("label_id") REFERENCES "public"."labels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "transactions_occurred_at_idx" ON "transactions" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "transactions_created_by_idx" ON "transactions" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "transactions_owner_user_id_idx" ON "transactions" USING btree ("owner_user_id") WHERE "transactions"."owner_user_id" is not null;--> statement-breakpoint
CREATE INDEX "transactions_group_id_idx" ON "transactions" USING btree ("group_id") WHERE "transactions"."group_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "transactions_owner_external_ref_unique" ON "transactions" USING btree ("owner_user_id","external_ref") WHERE "transactions"."external_ref" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "transactions_group_external_ref_unique" ON "transactions" USING btree ("group_id","external_ref") WHERE "transactions"."external_ref" is not null;--> statement-breakpoint
CREATE INDEX "transaction_splits_transaction_id_idx" ON "transaction_splits" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "transaction_splits_category_id_idx" ON "transaction_splits" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "labels_group_id_idx" ON "labels" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "labels_owner_user_id_idx" ON "labels" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "transaction_labels_label_id_idx" ON "transaction_labels" USING btree ("label_id");--> statement-breakpoint
-- The scope is derived, never chosen: any involved group account makes the whole movement group-scoped,
-- otherwise it is the caller's personal scope. `created_by` is stamped once, on insert (RF-25).
create or replace function private.set_transaction_scope() returns trigger
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
    -- A caller granted UPDATE still cannot rewrite who first recorded the movement.
    new.created_by := old.created_by;
  end if;
  return new;
end;
$$;
revoke all on function private.set_transaction_scope() from public, anon, authenticated, service_role;--> statement-breakpoint
create or replace function private.can_write_transaction(from_account_id uuid, to_account_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  -- Every named account must fall in the caller's writable scope (RF-62).
  select (from_account_id is null or private.can_write_account(from_account_id))
     and (to_account_id is null or private.can_write_account(to_account_id));
$$;--> statement-breakpoint
revoke all on function private.can_write_transaction(uuid, uuid) from public, anon, service_role;--> statement-breakpoint
grant execute on function private.can_write_transaction(uuid, uuid) to authenticated;--> statement-breakpoint
create or replace function private.can_read_transaction(uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  -- Mirrors the transactions SELECT predicate, for the splits and labels that hang off a movement.
  select exists (
    select 1 from public.transactions t
    where t.id = $1 and (
      t.owner_user_id = (select auth.uid())
      or private.is_group_member(coalesce(t.group_id, private.owner_group_id(t.owner_user_id)))
    )
  );
$$;--> statement-breakpoint
revoke all on function private.can_read_transaction(uuid) from public, anon, service_role;--> statement-breakpoint
grant execute on function private.can_read_transaction(uuid) to authenticated;--> statement-breakpoint
create or replace function private.can_write_transaction_row(uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  -- The writability of a split or label reduces to the writability of its parent movement's accounts.
  select private.can_write_transaction(t.from_account_id, t.to_account_id)
  from public.transactions t where t.id = $1;
$$;--> statement-breakpoint
revoke all on function private.can_write_transaction_row(uuid) from public, anon, service_role;--> statement-breakpoint
grant execute on function private.can_write_transaction_row(uuid) to authenticated;--> statement-breakpoint
create or replace function private.assert_split_matches_transaction() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  t public.transactions;
  c public.categories;
begin
  select * into t from public.transactions where id = new.transaction_id;
  select * into c from public.categories where id = new.category_id;
  -- A transfer moves money between accounts; it names no category (RF-69).
  if t.kind = 'transfer' then
    raise exception 'a transfer takes no split' using errcode = 'check_violation';
  end if;
  if c.owner_user_id is distinct from t.owner_user_id or c.group_id is distinct from t.group_id then
    raise exception 'a split category must share the movement''s scope' using errcode = 'check_violation';
  end if;
  if c.kind <> t.kind then
    raise exception 'a split category must share the movement''s kind' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
revoke all on function private.assert_split_matches_transaction() from public, anon, authenticated, service_role;--> statement-breakpoint
create or replace function private.assert_transaction_splits_sum() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_txn_id uuid;
  t public.transactions;
  v_sum bigint;
  v_count bigint;
begin
  if tg_table_name = 'transactions' then
    v_txn_id := new.id;
  else
    v_txn_id := coalesce(new.transaction_id, old.transaction_id);
  end if;
  -- The parent may have gone with a cascade delete: nothing left to reconcile.
  select * into t from public.transactions where id = v_txn_id;
  if not found then return null; end if;
  select coalesce(sum(amount_cents), 0), count(*) into v_sum, v_count
    from public.transaction_splits where transaction_id = v_txn_id;
  if t.kind = 'transfer' then
    if v_count > 0 then
      raise exception 'a transfer carries no split' using errcode = 'check_violation';
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
$$;
revoke all on function private.assert_transaction_splits_sum() from public, anon, authenticated, service_role;--> statement-breakpoint
create or replace function private.assert_label_matches_transaction() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  t public.transactions;
  l public.labels;
begin
  select * into t from public.transactions where id = new.transaction_id;
  select * into l from public.labels where id = new.label_id;
  if l.owner_user_id is distinct from t.owner_user_id or l.group_id is distinct from t.group_id then
    raise exception 'a label must share the movement''s scope' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
revoke all on function private.assert_label_matches_transaction() from public, anon, authenticated, service_role;--> statement-breakpoint
CREATE POLICY "transactions_select_member" ON "transactions" AS PERMISSIVE FOR SELECT TO "authenticated" USING (((select auth.uid()) = "transactions"."owner_user_id" or (select private.is_group_member(coalesce("transactions"."group_id", private.owner_group_id("transactions"."owner_user_id"))))));--> statement-breakpoint
CREATE POLICY "transactions_insert_writable" ON "transactions" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ((select private.can_write_transaction("transactions"."from_account_id", "transactions"."to_account_id")));--> statement-breakpoint
CREATE POLICY "transactions_update_writable" ON "transactions" AS PERMISSIVE FOR UPDATE TO "authenticated" USING ((select private.can_write_transaction("transactions"."from_account_id", "transactions"."to_account_id"))) WITH CHECK ((select private.can_write_transaction("transactions"."from_account_id", "transactions"."to_account_id")));--> statement-breakpoint
CREATE POLICY "transactions_delete_writable" ON "transactions" AS PERMISSIVE FOR DELETE TO "authenticated" USING ((select private.can_write_transaction("transactions"."from_account_id", "transactions"."to_account_id")));--> statement-breakpoint
CREATE POLICY "labels_select_member" ON "labels" AS PERMISSIVE FOR SELECT TO "authenticated" USING (((select auth.uid()) = "labels"."owner_user_id" or (select private.is_group_member(coalesce("labels"."group_id", private.owner_group_id("labels"."owner_user_id"))))));--> statement-breakpoint
CREATE POLICY "labels_insert_personal" ON "labels" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ((select auth.uid()) = "labels"."owner_user_id");--> statement-breakpoint
CREATE POLICY "labels_insert_group" ON "labels" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ((select private.is_group_leader("labels"."group_id")));--> statement-breakpoint
CREATE POLICY "labels_update_personal" ON "labels" AS PERMISSIVE FOR UPDATE TO "authenticated" USING ((select auth.uid()) = "labels"."owner_user_id") WITH CHECK ((select auth.uid()) = "labels"."owner_user_id");--> statement-breakpoint
CREATE POLICY "labels_update_group" ON "labels" AS PERMISSIVE FOR UPDATE TO "authenticated" USING ((select private.is_group_leader("labels"."group_id"))) WITH CHECK ((select private.is_group_leader("labels"."group_id")));--> statement-breakpoint
CREATE POLICY "labels_delete_personal" ON "labels" AS PERMISSIVE FOR DELETE TO "authenticated" USING ((select auth.uid()) = "labels"."owner_user_id");--> statement-breakpoint
CREATE POLICY "labels_delete_group" ON "labels" AS PERMISSIVE FOR DELETE TO "authenticated" USING ((select private.is_group_leader("labels"."group_id")));--> statement-breakpoint
ALTER TABLE "transaction_splits" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "transaction_labels" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- A split is visible when its movement is, and writable when its movement's accounts are (RF-69).
CREATE POLICY "transaction_splits_select_member" ON "transaction_splits" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((select private.can_read_transaction("transaction_splits"."transaction_id")));--> statement-breakpoint
CREATE POLICY "transaction_splits_insert_writable" ON "transaction_splits" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ((select private.can_write_transaction_row("transaction_splits"."transaction_id")));--> statement-breakpoint
CREATE POLICY "transaction_splits_update_writable" ON "transaction_splits" AS PERMISSIVE FOR UPDATE TO "authenticated" USING ((select private.can_write_transaction_row("transaction_splits"."transaction_id"))) WITH CHECK ((select private.can_write_transaction_row("transaction_splits"."transaction_id")));--> statement-breakpoint
CREATE POLICY "transaction_splits_delete_writable" ON "transaction_splits" AS PERMISSIVE FOR DELETE TO "authenticated" USING ((select private.can_write_transaction_row("transaction_splits"."transaction_id")));--> statement-breakpoint
-- A label attachment follows the same read/write rule as the split (RF-70).
CREATE POLICY "transaction_labels_select_member" ON "transaction_labels" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((select private.can_read_transaction("transaction_labels"."transaction_id")));--> statement-breakpoint
CREATE POLICY "transaction_labels_insert_writable" ON "transaction_labels" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ((select private.can_write_transaction_row("transaction_labels"."transaction_id")));--> statement-breakpoint
CREATE POLICY "transaction_labels_delete_writable" ON "transaction_labels" AS PERMISSIVE FOR DELETE TO "authenticated" USING ((select private.can_write_transaction_row("transaction_labels"."transaction_id")));--> statement-breakpoint
ALTER TABLE "transactions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "transaction_splits" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "labels" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "transaction_labels" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "transactions" FROM public, anon, authenticated, service_role;--> statement-breakpoint
GRANT SELECT ON TABLE "transactions" TO authenticated;--> statement-breakpoint
GRANT INSERT (from_account_id, to_account_id, amount_cents, occurred_at, description, external_ref) ON TABLE "transactions" TO authenticated;--> statement-breakpoint
GRANT UPDATE (from_account_id, to_account_id, amount_cents, occurred_at, description) ON TABLE "transactions" TO authenticated;--> statement-breakpoint
GRANT DELETE ON TABLE "transactions" TO authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "transaction_splits" FROM public, anon, authenticated, service_role;--> statement-breakpoint
GRANT SELECT ON TABLE "transaction_splits" TO authenticated;--> statement-breakpoint
GRANT INSERT (transaction_id, category_id, amount_cents) ON TABLE "transaction_splits" TO authenticated;--> statement-breakpoint
GRANT UPDATE (category_id, amount_cents) ON TABLE "transaction_splits" TO authenticated;--> statement-breakpoint
GRANT DELETE ON TABLE "transaction_splits" TO authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "labels" FROM public, anon, authenticated, service_role;--> statement-breakpoint
GRANT SELECT ON TABLE "labels" TO authenticated;--> statement-breakpoint
GRANT INSERT (group_id, owner_user_id, name, color) ON TABLE "labels" TO authenticated;--> statement-breakpoint
GRANT UPDATE (name, color) ON TABLE "labels" TO authenticated;--> statement-breakpoint
GRANT DELETE ON TABLE "labels" TO authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "transaction_labels" FROM public, anon, authenticated, service_role;--> statement-breakpoint
GRANT SELECT ON TABLE "transaction_labels" TO authenticated;--> statement-breakpoint
GRANT INSERT (transaction_id, label_id) ON TABLE "transaction_labels" TO authenticated;--> statement-breakpoint
GRANT DELETE ON TABLE "transaction_labels" TO authenticated;--> statement-breakpoint
CREATE TRIGGER transactions_set_timestamps BEFORE INSERT OR UPDATE ON "transactions"
  FOR EACH ROW EXECUTE FUNCTION private.set_row_timestamps();--> statement-breakpoint
CREATE TRIGGER transactions_set_scope BEFORE INSERT OR UPDATE ON "transactions"
  FOR EACH ROW EXECUTE FUNCTION private.set_transaction_scope();--> statement-breakpoint
CREATE TRIGGER labels_set_timestamps BEFORE INSERT OR UPDATE ON "labels"
  FOR EACH ROW EXECUTE FUNCTION private.set_row_timestamps();--> statement-breakpoint
CREATE TRIGGER transaction_splits_assert_match BEFORE INSERT OR UPDATE ON "transaction_splits"
  FOR EACH ROW EXECUTE FUNCTION private.assert_split_matches_transaction();--> statement-breakpoint
CREATE TRIGGER transaction_labels_assert_match BEFORE INSERT OR UPDATE ON "transaction_labels"
  FOR EACH ROW EXECUTE FUNCTION private.assert_label_matches_transaction();--> statement-breakpoint
-- Deferred to commit: a split set is built row by row and only balances once complete.
CREATE CONSTRAINT TRIGGER "transaction_splits_assert_sum"
  AFTER INSERT OR UPDATE OR DELETE ON "transaction_splits"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION private.assert_transaction_splits_sum();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "transactions_assert_splits_sum"
  AFTER INSERT OR UPDATE ON "transactions"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION private.assert_transaction_splits_sum();--> statement-breakpoint
-- The balance is derived from movements, never stored (RNF-07): amounts are positive and the side
-- carries the sign (RF-20). `security_invoker` keeps the movements behind the caller's own RLS.
create view account_balances with (security_invoker = on) as
  select a.id,
    a.initial_balance_cents
      + coalesce((select sum(t.amount_cents) from public.transactions t where t.to_account_id = a.id), 0)
      - coalesce((select sum(t.amount_cents) from public.transactions t where t.from_account_id = a.id), 0)
      as balance_cents
  from public.accounts a;
--> statement-breakpoint
revoke all on account_balances from public, anon, authenticated, service_role;--> statement-breakpoint
grant select on account_balances to authenticated;--> statement-breakpoint
-- Scope-leading covering indexes so the balance SUM is an index-only scan under the RNF-09 budget:
-- the RLS scope column leads, the account and date follow, the amount rides along in INCLUDE.
CREATE INDEX "transactions_group_from_balance_idx" ON "transactions" USING btree ("group_id", "from_account_id", "occurred_at") INCLUDE ("amount_cents") WHERE "group_id" is not null;--> statement-breakpoint
CREATE INDEX "transactions_group_to_balance_idx" ON "transactions" USING btree ("group_id", "to_account_id", "occurred_at") INCLUDE ("amount_cents") WHERE "group_id" is not null;--> statement-breakpoint
CREATE INDEX "transactions_owner_from_balance_idx" ON "transactions" USING btree ("owner_user_id", "from_account_id", "occurred_at") INCLUDE ("amount_cents") WHERE "owner_user_id" is not null;--> statement-breakpoint
CREATE INDEX "transactions_owner_to_balance_idx" ON "transactions" USING btree ("owner_user_id", "to_account_id", "occurred_at") INCLUDE ("amount_cents") WHERE "owner_user_id" is not null;
