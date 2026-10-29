CREATE TABLE "app_users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"locale" text DEFAULT 'es' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app_users" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"currency" text DEFAULT 'COP' NOT NULL,
	"cash_mode" text DEFAULT 'shared' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "groups_name_length" CHECK (length(btrim("groups"."name")) between 1 and 80),
	CONSTRAINT "groups_cash_mode_valid" CHECK ("groups"."cash_mode" in ('shared', 'per_member'))
);
--> statement-breakpoint
ALTER TABLE "groups" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "group_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"user_id" uuid,
	"name" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "group_members_name_length" CHECK (length(btrim("group_members"."name")) between 1 and 80),
	CONSTRAINT "group_members_role_valid" CHECK ("group_members"."role" in ('leader', 'member')),
	CONSTRAINT "group_members_leader_has_user" CHECK ("group_members"."role" <> 'leader' or "group_members"."user_id" is not null)
);
--> statement-breakpoint
ALTER TABLE "group_members" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid,
	"group_id" uuid,
	"is_shared" boolean DEFAULT false NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"institution" text,
	"initial_balance_cents" bigint DEFAULT 0 NOT NULL,
	"initial_balance_on" date NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_name_length" CHECK (length(btrim("accounts"."name")) between 1 and 80),
	CONSTRAINT "accounts_kind_valid" CHECK ("accounts"."kind" in ('asset', 'liability')),
	CONSTRAINT "accounts_initial_balance_sign" CHECK (("accounts"."kind" = 'asset' and "accounts"."initial_balance_cents" >= 0) or ("accounts"."kind" = 'liability' and "accounts"."initial_balance_cents" <= 0)),
	CONSTRAINT "accounts_owner_xor_group" CHECK (num_nonnulls("accounts"."owner_user_id", "accounts"."group_id") = 1),
	CONSTRAINT "accounts_personal_not_shared" CHECK ("accounts"."owner_user_id" is null or "accounts"."is_shared" = false)
);
--> statement-breakpoint
ALTER TABLE "accounts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid,
	"group_id" uuid,
	"parent_id" uuid,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"color" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "categories_id_group_id_unique" UNIQUE("id","group_id"),
	CONSTRAINT "categories_name_length" CHECK (length(btrim("categories"."name")) between 1 and 80),
	CONSTRAINT "categories_kind_valid" CHECK ("categories"."kind" in ('expense', 'income')),
	CONSTRAINT "categories_owner_xor_group" CHECK (num_nonnulls("categories"."owner_user_id", "categories"."group_id") = 1)
);
--> statement-breakpoint
ALTER TABLE "categories" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app_users" ADD CONSTRAINT "app_users_id_users_id_fk" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_owner_user_id_app_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."app_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_owner_user_id_app_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_parent_id_group_id_categories_id_group_id_fk" FOREIGN KEY ("parent_id","group_id") REFERENCES "public"."categories"("id","group_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "group_members_user_unique" ON "group_members" USING btree ("user_id") WHERE "group_members"."user_id" is not null and "group_members"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "group_members_group_id_idx" ON "group_members" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "group_members_user_id_idx" ON "group_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "accounts_group_id_idx" ON "accounts" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "accounts_owner_user_id_idx" ON "accounts" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "categories_group_id_idx" ON "categories" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "categories_owner_user_id_idx" ON "categories" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "categories_parent_id_idx" ON "categories" USING btree ("parent_id");--> statement-breakpoint
create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated;
--> statement-breakpoint
create or replace function private.set_row_timestamps() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := pg_catalog.now();
  else
    -- A caller granted UPDATE still cannot rewrite when the row was born.
    new.created_at := old.created_at;
  end if;
  new.updated_at := pg_catalog.now();
  return new;
end;
$$;
revoke all on function private.set_row_timestamps() from public, anon, authenticated, service_role;--> statement-breakpoint
create or replace function private.is_group_member(uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.group_members m
    where m.group_id = $1 and m.user_id = (select auth.uid()) and m.archived_at is null
  );
$$;--> statement-breakpoint
revoke all on function private.is_group_member(uuid) from public, anon, service_role;--> statement-breakpoint
grant execute on function private.is_group_member(uuid) to authenticated;--> statement-breakpoint
create or replace function private.is_group_leader(uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.group_members m
    where m.group_id = $1 and m.user_id = (select auth.uid()) and m.role = 'leader' and m.archived_at is null
  );
$$;--> statement-breakpoint
revoke all on function private.is_group_leader(uuid) from public, anon, service_role;--> statement-breakpoint
grant execute on function private.is_group_leader(uuid) to authenticated;--> statement-breakpoint
create or replace function private.owner_group_id(p_owner uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select group_id from public.group_members where user_id = p_owner and archived_at is null limit 1
$$;--> statement-breakpoint
revoke all on function private.owner_group_id(uuid) from public, anon, service_role;--> statement-breakpoint
grant execute on function private.owner_group_id(uuid) to authenticated;--> statement-breakpoint
create or replace function private.group_is_unclaimed(uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select not exists (select 1 from public.group_members m where m.group_id = $1);
$$;--> statement-breakpoint
revoke all on function private.group_is_unclaimed(uuid) from public, anon, service_role;--> statement-breakpoint
grant execute on function private.group_is_unclaimed(uuid) to authenticated;--> statement-breakpoint
create or replace function private.can_write_account(account_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  -- The owner writes their own account; any group member writes one the owner marked shared.
  select exists (
    select 1 from public.accounts a
    where a.id = $1 and (
      a.owner_user_id = (select auth.uid())
      or (a.is_shared and private.is_group_member(a.group_id))
    )
  );
$$;--> statement-breakpoint
revoke all on function private.can_write_account(uuid) from public, anon, service_role;--> statement-breakpoint
grant execute on function private.can_write_account(uuid) to authenticated;--> statement-breakpoint
create or replace function private.assert_group_keeps_leader() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  -- The group itself is gone: the cascade took its members with it, which is legal.
  if not exists (select 1 from public.groups g where g.id = old.group_id) then return null; end if;
  if not exists (
    select 1 from public.group_members m
    where m.group_id = old.group_id and m.role = 'leader' and m.archived_at is null
  ) then
    raise exception 'group % would be left without a leader', old.group_id using errcode = 'check_violation';
  end if;
  return null;
end;
$$;
revoke all on function private.assert_group_keeps_leader() from public, anon, authenticated, service_role;--> statement-breakpoint
create or replace function private.assert_category_depth() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  parent public.categories;
begin
  if new.parent_id is null then return new; end if;
  if new.parent_id = new.id then
    raise exception 'a category cannot be its own parent' using errcode = 'check_violation';
  end if;
  if exists (select 1 from public.categories c where c.parent_id = new.id) then
    raise exception 'category % already has children and cannot become one', new.id using errcode = 'check_violation';
  end if;
  select * into parent from public.categories c where c.id = new.parent_id;
  if parent.parent_id is not null then
    raise exception 'nesting stops at one level' using errcode = 'check_violation';
  end if;
  if parent.kind <> new.kind then
    raise exception 'a subcategory must share its parent''s kind' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
revoke all on function private.assert_category_depth() from public, anon, authenticated, service_role;--> statement-breakpoint
CREATE POLICY "app_users_select_self" ON "app_users" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((select auth.uid()) = "app_users"."id");--> statement-breakpoint
CREATE POLICY "app_users_insert_self" ON "app_users" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ((select auth.uid()) = "app_users"."id");--> statement-breakpoint
CREATE POLICY "app_users_update_self" ON "app_users" AS PERMISSIVE FOR UPDATE TO "authenticated" USING ((select auth.uid()) = "app_users"."id") WITH CHECK ((select auth.uid()) = "app_users"."id");--> statement-breakpoint
CREATE POLICY "groups_select_member" ON "groups" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((select private.is_group_member("groups"."id")));--> statement-breakpoint
CREATE POLICY "groups_insert_any" ON "groups" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "group_members_select_member" ON "group_members" AS PERMISSIVE FOR SELECT TO "authenticated" USING (("group_members"."user_id" = (select auth.uid()) or (select private.is_group_member("group_members"."group_id"))));--> statement-breakpoint
CREATE POLICY "group_members_insert_leader_claim" ON "group_members" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ((select auth.uid()) = "group_members"."user_id" and "group_members"."role" = 'leader' and (select private.group_is_unclaimed("group_members"."group_id")));--> statement-breakpoint
CREATE POLICY "group_members_insert_member" ON "group_members" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ((select private.is_group_member("group_members"."group_id")) and "group_members"."user_id" is null and "group_members"."role" = 'member');--> statement-breakpoint
CREATE POLICY "group_members_update_member" ON "group_members" AS PERMISSIVE FOR UPDATE TO "authenticated" USING ((select private.is_group_member("group_members"."group_id"))) WITH CHECK ((select private.is_group_member("group_members"."group_id")) and ("group_members"."user_id" is distinct from (select auth.uid()) or "group_members"."archived_at" is null));--> statement-breakpoint
CREATE POLICY "group_members_delete_member" ON "group_members" AS PERMISSIVE FOR DELETE TO "authenticated" USING ((select private.is_group_member("group_members"."group_id")) and "group_members"."user_id" is distinct from (select auth.uid()));--> statement-breakpoint
CREATE POLICY "accounts_select_group" ON "accounts" AS PERMISSIVE FOR SELECT TO "authenticated" USING (("accounts"."owner_user_id" = (select auth.uid()) or (select private.is_group_member(coalesce("accounts"."group_id", private.owner_group_id("accounts"."owner_user_id"))))));--> statement-breakpoint
CREATE POLICY "accounts_insert_writable" ON "accounts" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK (("accounts"."owner_user_id" = (select auth.uid()) or ("accounts"."is_shared" and (select private.is_group_member("accounts"."group_id")))));--> statement-breakpoint
CREATE POLICY "accounts_update_writable" ON "accounts" AS PERMISSIVE FOR UPDATE TO "authenticated" USING ((select private.can_write_account("accounts"."id"))) WITH CHECK ((select private.can_write_account("accounts"."id")));--> statement-breakpoint
CREATE POLICY "accounts_delete_writable" ON "accounts" AS PERMISSIVE FOR DELETE TO "authenticated" USING ((select private.can_write_account("accounts"."id")));--> statement-breakpoint
CREATE POLICY "categories_select_member" ON "categories" AS PERMISSIVE FOR SELECT TO "authenticated" USING (((select auth.uid()) = "categories"."owner_user_id" or (select private.is_group_member(coalesce("categories"."group_id", private.owner_group_id("categories"."owner_user_id"))))));--> statement-breakpoint
CREATE POLICY "categories_insert_personal" ON "categories" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ((select auth.uid()) = "categories"."owner_user_id");--> statement-breakpoint
CREATE POLICY "categories_insert_group" ON "categories" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ((select private.is_group_leader("categories"."group_id")));--> statement-breakpoint
CREATE POLICY "categories_update_personal" ON "categories" AS PERMISSIVE FOR UPDATE TO "authenticated" USING ((select auth.uid()) = "categories"."owner_user_id") WITH CHECK ((select auth.uid()) = "categories"."owner_user_id");--> statement-breakpoint
CREATE POLICY "categories_update_group" ON "categories" AS PERMISSIVE FOR UPDATE TO "authenticated" USING ((select private.is_group_leader("categories"."group_id"))) WITH CHECK ((select private.is_group_leader("categories"."group_id")));--> statement-breakpoint
CREATE POLICY "categories_delete_personal" ON "categories" AS PERMISSIVE FOR DELETE TO "authenticated" USING ((select auth.uid()) = "categories"."owner_user_id");--> statement-breakpoint
CREATE POLICY "categories_delete_group" ON "categories" AS PERMISSIVE FOR DELETE TO "authenticated" USING ((select private.is_group_leader("categories"."group_id")));--> statement-breakpoint
ALTER TABLE "app_users" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "groups" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "group_members" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "accounts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "categories" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "app_users" FROM public, anon, authenticated, service_role;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "app_users" TO authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "groups" FROM public, anon, authenticated, service_role;--> statement-breakpoint
GRANT SELECT ON TABLE "groups" TO authenticated;--> statement-breakpoint
GRANT INSERT (id, name, cash_mode) ON TABLE "groups" TO authenticated;--> statement-breakpoint
GRANT UPDATE (name, cash_mode) ON TABLE "groups" TO authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "group_members" FROM public, anon, authenticated, service_role;--> statement-breakpoint
GRANT SELECT ON TABLE "group_members" TO authenticated;--> statement-breakpoint
GRANT INSERT ON TABLE "group_members" TO authenticated;--> statement-breakpoint
GRANT UPDATE (name, archived_at) ON TABLE "group_members" TO authenticated;--> statement-breakpoint
GRANT DELETE ON TABLE "group_members" TO authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "accounts" FROM public, anon, authenticated, service_role;--> statement-breakpoint
GRANT SELECT ON TABLE "accounts" TO authenticated;--> statement-breakpoint
GRANT INSERT (group_id, owner_user_id, name, kind, institution, is_shared, initial_balance_cents, initial_balance_on) ON TABLE "accounts" TO authenticated;--> statement-breakpoint
GRANT UPDATE (name, institution, is_shared, initial_balance_cents, initial_balance_on, archived_at) ON TABLE "accounts" TO authenticated;--> statement-breakpoint
GRANT DELETE ON TABLE "accounts" TO authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "categories" FROM public, anon, authenticated, service_role;--> statement-breakpoint
GRANT SELECT ON TABLE "categories" TO authenticated;--> statement-breakpoint
GRANT INSERT (group_id, owner_user_id, parent_id, name, kind, color) ON TABLE "categories" TO authenticated;--> statement-breakpoint
GRANT UPDATE (name, color, parent_id) ON TABLE "categories" TO authenticated;--> statement-breakpoint
GRANT DELETE ON TABLE "categories" TO authenticated;--> statement-breakpoint
CREATE TRIGGER groups_set_timestamps BEFORE INSERT OR UPDATE ON "groups"
  FOR EACH ROW EXECUTE FUNCTION private.set_row_timestamps();--> statement-breakpoint
CREATE TRIGGER group_members_set_timestamps BEFORE INSERT OR UPDATE ON "group_members"
  FOR EACH ROW EXECUTE FUNCTION private.set_row_timestamps();--> statement-breakpoint
CREATE TRIGGER accounts_set_timestamps BEFORE INSERT OR UPDATE ON "accounts"
  FOR EACH ROW EXECUTE FUNCTION private.set_row_timestamps();--> statement-breakpoint
CREATE TRIGGER categories_set_timestamps BEFORE INSERT OR UPDATE ON "categories"
  FOR EACH ROW EXECUTE FUNCTION private.set_row_timestamps();--> statement-breakpoint
CREATE TRIGGER categories_assert_depth BEFORE INSERT OR UPDATE ON "categories"
  FOR EACH ROW EXECUTE FUNCTION private.assert_category_depth();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "group_members_keep_leader"
  AFTER UPDATE OR DELETE ON "group_members"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (OLD.role = 'leader' AND OLD.archived_at IS NULL)
  EXECUTE FUNCTION private.assert_group_keeps_leader();