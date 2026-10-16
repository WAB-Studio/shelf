CREATE TABLE "webhook_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"default_account_id" uuid,
	"default_category_id" uuid,
	"rate_limit_per_min" integer DEFAULT 60 NOT NULL,
	"rate_window_started_at" timestamp with time zone,
	"rate_count" integer DEFAULT 0 NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_credentials_name_length" CHECK (length("webhook_credentials"."name") between 1 and 80),
	CONSTRAINT "webhook_credentials_token_hash_length" CHECK (length("webhook_credentials"."token_hash") = 64),
	CONSTRAINT "webhook_credentials_rate_limit_positive" CHECK ("webhook_credentials"."rate_limit_per_min" > 0),
	CONSTRAINT "webhook_credentials_rate_count_non_negative" CHECK ("webhook_credentials"."rate_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "webhook_credentials" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "webhook_credentials" ADD CONSTRAINT "webhook_credentials_owner_user_id_app_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_credentials" ADD CONSTRAINT "webhook_credentials_default_account_id_accounts_id_fk" FOREIGN KEY ("default_account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_credentials" ADD CONSTRAINT "webhook_credentials_default_category_id_categories_id_fk" FOREIGN KEY ("default_category_id") REFERENCES "public"."categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_credentials_token_hash_unique" ON "webhook_credentials" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "webhook_credentials_owner_user_id_idx" ON "webhook_credentials" USING btree ("owner_user_id");--> statement-breakpoint
CREATE POLICY "webhook_credentials_select" ON "webhook_credentials" AS PERMISSIVE FOR SELECT TO "authenticated" USING ("webhook_credentials"."owner_user_id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "webhook_credentials_insert" ON "webhook_credentials" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ("webhook_credentials"."owner_user_id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "webhook_credentials_update" ON "webhook_credentials" AS PERMISSIVE FOR UPDATE TO "authenticated" USING ("webhook_credentials"."owner_user_id" = (select auth.uid())) WITH CHECK ("webhook_credentials"."owner_user_id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "webhook_credentials_delete" ON "webhook_credentials" AS PERMISSIVE FOR DELETE TO "authenticated" USING ("webhook_credentials"."owner_user_id" = (select auth.uid()));--> statement-breakpoint
-- Owner is stamped from auth.uid() on insert (RF-85); a credential always belongs to whoever created it.
create or replace function private.set_webhook_credential_owner() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.owner_user_id := (select auth.uid());
  return new;
end;
$$;
revoke all on function private.set_webhook_credential_owner() from public, anon, authenticated, service_role;--> statement-breakpoint
-- The signed webhook resolves a token hash to its owner and defaults, and applies a per-credential
-- fixed-window rate limit whose counters it alone manages (RF-86, RNF-04). The row lock serializes
-- concurrent hits on the same credential so the window and count never race. An unknown or revoked
-- token returns no row; the route maps that to 401.
create or replace function private.resolve_webhook_credential(p_token_hash text)
returns table(owner_user_id uuid, default_account_id uuid, default_category_id uuid, throttled boolean)
language plpgsql security definer set search_path = '' as $$
declare
  v_cred public.webhook_credentials;
  v_reset boolean;
  v_throttled boolean;
begin
  select * into v_cred from public.webhook_credentials c
    where c.token_hash = p_token_hash and c.revoked_at is null
    for update;
  if not found then return; end if;
  v_reset := v_cred.rate_window_started_at is null
             or (pg_catalog.now() - v_cred.rate_window_started_at) >= interval '1 minute';
  if v_reset then
    v_throttled := false;
    update public.webhook_credentials set last_used_at = pg_catalog.now(),
      rate_window_started_at = pg_catalog.now(), rate_count = 1 where id = v_cred.id;
  elsif v_cred.rate_count < v_cred.rate_limit_per_min then
    -- The request that reaches exactly the limit is still admitted.
    v_throttled := false;
    update public.webhook_credentials set last_used_at = pg_catalog.now(),
      rate_count = v_cred.rate_count + 1 where id = v_cred.id;
  else
    -- Over the limit: a valid token, but do not count it and do not admit it.
    v_throttled := true;
    update public.webhook_credentials set last_used_at = pg_catalog.now() where id = v_cred.id;
  end if;
  return query select v_cred.owner_user_id, v_cred.default_account_id, v_cred.default_category_id, v_throttled;
end;
$$;
revoke all on function private.resolve_webhook_credential(text) from public, anon, authenticated, service_role;--> statement-breakpoint
-- The identified-system read (RNF-04): the webhook route calls this over the base `db` connection, which
-- connects as the object owner `postgres`; the owner executes it without a grant. It never runs as
-- `authenticated`, so no such grant is issued.
ALTER TABLE "webhook_credentials" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "webhook_credentials" FROM anon, authenticated, service_role;--> statement-breakpoint
GRANT SELECT (id, owner_user_id, name, default_account_id, default_category_id, rate_limit_per_min, last_used_at, revoked_at, created_at, updated_at) ON TABLE "webhook_credentials" TO authenticated;--> statement-breakpoint
GRANT INSERT (name, token_hash, default_account_id, default_category_id, rate_limit_per_min) ON TABLE "webhook_credentials" TO authenticated;--> statement-breakpoint
GRANT UPDATE (name, default_account_id, default_category_id, rate_limit_per_min, revoked_at) ON TABLE "webhook_credentials" TO authenticated;--> statement-breakpoint
GRANT DELETE ON TABLE "webhook_credentials" TO authenticated;--> statement-breakpoint
CREATE TRIGGER webhook_credentials_set_timestamps BEFORE INSERT OR UPDATE ON "webhook_credentials"
  FOR EACH ROW EXECUTE FUNCTION private.set_row_timestamps();--> statement-breakpoint
CREATE TRIGGER set_webhook_credential_owner BEFORE INSERT ON "webhook_credentials"
  FOR EACH ROW EXECUTE FUNCTION private.set_webhook_credential_owner();