CREATE TABLE "finances"."oauth_clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_name" text NOT NULL,
	"redirect_uris" text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_active_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_clients_name_length" CHECK (char_length("finances"."oauth_clients"."client_name") between 1 and 80),
	CONSTRAINT "oauth_clients_redirect_uris_count" CHECK (cardinality("finances"."oauth_clients"."redirect_uris") between 1 and 5)
);
--> statement-breakpoint
ALTER TABLE "finances"."oauth_clients" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "finances"."oauth_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"code_challenge" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"expires_at" timestamp with time zone DEFAULT now() + interval '10 minutes' NOT NULL,
	"used_at" timestamp with time zone,
	"credential_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_codes_code_hash_unique" UNIQUE("code_hash")
);
--> statement-breakpoint
ALTER TABLE "finances"."oauth_codes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "finances"."oauth_calls" (
	"bucket" text NOT NULL,
	"source" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"calls" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "oauth_calls_bucket_source_window_start_pk" PRIMARY KEY("bucket","source","window_start"),
	CONSTRAINT "oauth_calls_bucket_known" CHECK ("finances"."oauth_calls"."bucket" in ('register'))
);
--> statement-breakpoint
ALTER TABLE "finances"."oauth_calls" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "finances"."oauth_codes" ADD CONSTRAINT "oauth_codes_owner_user_id_app_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "finances"."app_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finances"."oauth_codes" ADD CONSTRAINT "oauth_codes_client_id_oauth_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "finances"."oauth_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finances"."oauth_codes" ADD CONSTRAINT "oauth_codes_credential_id_webhook_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "finances"."webhook_credentials"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "oauth_codes_owner_user_id_idx" ON "finances"."oauth_codes" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "oauth_codes_client_id_idx" ON "finances"."oauth_codes" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "oauth_codes_credential_id_idx" ON "finances"."oauth_codes" USING btree ("credential_id");--> statement-breakpoint
CREATE POLICY "oauth_codes_insert" ON "finances"."oauth_codes" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ("finances"."oauth_codes"."owner_user_id" = (select auth.uid()));
-- RF-168, hand-written: drizzle-kit diffs neither a grant, a function nor a trigger. The tables are closed like
-- `allowed_emails`: only the server's own pool, their owner, reads or writes them, bar the consent's insert below.
REVOKE ALL ON TABLE "finances"."oauth_clients" FROM "anon", "authenticated", "service_role";
--> statement-breakpoint
REVOKE ALL ON TABLE "finances"."oauth_codes" FROM "anon", "authenticated", "service_role";
--> statement-breakpoint
-- The consent inserts a code as the signed-in person (policy `oauth_codes_insert`), naming these columns alone.
GRANT INSERT (owner_user_id, client_id, code_hash, code_challenge, redirect_uri) ON TABLE "finances"."oauth_codes" TO "authenticated";
--> statement-breakpoint
REVOKE ALL ON TABLE "finances"."oauth_calls" FROM "anon", "authenticated", "service_role";
--> statement-breakpoint
-- The two tables are audited like every other write (RF-43/45); a registration has no actor and no scope. The
-- call counter is not: it moves on every request and holds no fund data.
CREATE TRIGGER capture_audit AFTER INSERT OR UPDATE OR DELETE ON "finances"."oauth_clients"
  FOR EACH ROW EXECUTE FUNCTION private.capture_audit();
--> statement-breakpoint
CREATE TRIGGER capture_audit AFTER INSERT OR UPDATE OR DELETE ON "finances"."oauth_codes"
  FOR EACH ROW EXECUTE FUNCTION private.capture_audit();
--> statement-breakpoint
-- Redeems a code once and mints the `mcp` key it buys. The exchange has no session, and the credential's owner
-- trigger stamps `auth.uid()`, so the code's owner is put there for this transaction alone. A code that was
-- already redeemed is a replay: the key it bought is revoked and the answer is the same refusal. A new key
-- replaces the person's live keys for the same client, so each connection holds one.
CREATE FUNCTION private.exchange_oauth_code(p_code_hash text, p_challenge text, p_client uuid, p_redirect text, p_token_hash text, p_rate_limit integer)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  c finances.oauth_codes;
  v_credential uuid;
begin
  select * into c from finances.oauth_codes k where k.code_hash = p_code_hash for update;
  if not found then
    return null;
  end if;
  if c.used_at is not null then
    update finances.webhook_credentials w set revoked_at = pg_catalog.now()
     where w.id = c.credential_id and w.revoked_at is null;
    return null;
  end if;
  if c.expires_at <= pg_catalog.now() or c.code_challenge <> p_challenge
     or c.client_id <> p_client or c.redirect_uri <> p_redirect then
    return null;
  end if;
  update finances.webhook_credentials w set revoked_at = pg_catalog.now()
   where w.revoked_at is null and w.id in (
     select k.credential_id from finances.oauth_codes k
      where k.owner_user_id = c.owner_user_id and k.client_id = c.client_id and k.credential_id is not null);
  perform pg_catalog.set_config('request.jwt.claim.sub', c.owner_user_id::text, true);
  insert into finances.webhook_credentials (name, token_hash, purpose, rate_limit_per_min, owner_user_id)
  select pg_catalog.left(o.client_name, 80), p_token_hash, 'mcp', p_rate_limit, c.owner_user_id
    from finances.oauth_clients o where o.id = c.client_id
  returning id into v_credential;
  update finances.oauth_codes k set used_at = pg_catalog.now(), credential_id = v_credential where k.id = c.id;
  update finances.oauth_clients o set last_active_at = pg_catalog.now() where o.id = c.client_id;
  return c.owner_user_id;
end
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION private.exchange_oauth_code(text, text, uuid, text, text, integer) FROM PUBLIC, "anon", "authenticated", "service_role";
--> statement-breakpoint
-- Registers a client. A client a connector may still cache is never swept by age: only one with no code issued
-- for 30 days goes (its codes with it), and spent or expired codes go after a day. The register throttle, not
-- this sweep, is what bounds abuse.
CREATE FUNCTION private.register_oauth_client(p_name text, p_uris text[])
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  with swept_codes as (
    delete from finances.oauth_codes k where k.expires_at < pg_catalog.now() - interval '1 day'
  ),
  swept_clients as (
    delete from finances.oauth_clients c where c.last_active_at < pg_catalog.now() - interval '30 days'
  )
  insert into finances.oauth_clients (client_name, redirect_uris) values (p_name, p_uris) returning id
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION private.register_oauth_client(text, text[]) FROM PUBLIC, "anon", "authenticated", "service_role";
--> statement-breakpoint
-- Counts one call in the caller's current window and returns 0 while it is within `cap`, else the whole seconds
-- left in the window. One statement, so two calls cannot both slip under the cap. Parameters carry a prefix
-- because a column of the same name would win inside a SQL function.
CREATE FUNCTION private.claim_oauth_call(p_bucket text, p_source text, p_cap integer, p_window_seconds integer)
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  with swept as (
    delete from finances.oauth_calls o where o.window_start < pg_catalog.now() - interval '1 day'
  ),
  slot as (
    select pg_catalog.date_bin(pg_catalog.make_interval(secs => p_window_seconds), pg_catalog.now(), timestamptz 'epoch') as starts
  ),
  claimed as (
    insert into finances.oauth_calls (bucket, source, window_start)
    select p_bucket, p_source, slot.starts from slot
    on conflict (bucket, source, window_start)
    do update set calls = finances.oauth_calls.calls + 1
    returning calls, window_start
  )
  select case
    when claimed.calls <= p_cap then 0
    else greatest(1, pg_catalog.ceil(extract(epoch from claimed.window_start + pg_catalog.make_interval(secs => p_window_seconds) - pg_catalog.now()))::integer)
  end
  from claimed
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION private.claim_oauth_call(text, text, integer, integer) FROM PUBLIC, "anon", "authenticated", "service_role";
