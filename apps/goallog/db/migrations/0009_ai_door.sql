CREATE TABLE "goals"."access_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text DEFAULT 'personal' NOT NULL,
	"name" text NOT NULL,
	"token_hash" "bytea" NOT NULL,
	"hint" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "access_tokens_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "access_tokens_kind_known" CHECK ("goals"."access_tokens"."kind" in ('personal', 'oauth')),
	CONSTRAINT "access_tokens_name_length" CHECK (char_length("goals"."access_tokens"."name") between 1 and 60)
);
--> statement-breakpoint
ALTER TABLE "goals"."access_tokens" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "goals"."oauth_clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_name" text NOT NULL,
	"redirect_uris" text[] NOT NULL,
	"metadata_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_clients_metadata_url_unique" UNIQUE("metadata_url"),
	CONSTRAINT "oauth_clients_name_length" CHECK (char_length("goals"."oauth_clients"."client_name") between 1 and 80),
	CONSTRAINT "oauth_clients_redirect_uris_count" CHECK (cardinality("goals"."oauth_clients"."redirect_uris") between 1 and 5)
);
--> statement-breakpoint
ALTER TABLE "goals"."oauth_clients" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "goals"."oauth_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"code_hash" "bytea" NOT NULL,
	"code_challenge" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"resource" text NOT NULL,
	"expires_at" timestamp with time zone DEFAULT now() + interval '10 minutes' NOT NULL,
	"used_at" timestamp with time zone,
	"access_token_id" uuid,
	CONSTRAINT "oauth_codes_code_hash_unique" UNIQUE("code_hash")
);
--> statement-breakpoint
ALTER TABLE "goals"."oauth_codes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "goals"."oauth_refresh" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"access_token_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"refresh_hash" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"used_at" timestamp with time zone,
	CONSTRAINT "oauth_refresh_refresh_hash_unique" UNIQUE("refresh_hash")
);
--> statement-breakpoint
ALTER TABLE "goals"."oauth_refresh" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "goals"."access_tokens" ADD CONSTRAINT "access_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goals"."oauth_codes" ADD CONSTRAINT "oauth_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goals"."oauth_codes" ADD CONSTRAINT "oauth_codes_client_id_oauth_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "goals"."oauth_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goals"."oauth_codes" ADD CONSTRAINT "oauth_codes_access_token_id_access_tokens_id_fk" FOREIGN KEY ("access_token_id") REFERENCES "goals"."access_tokens"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goals"."oauth_refresh" ADD CONSTRAINT "oauth_refresh_access_token_id_access_tokens_id_fk" FOREIGN KEY ("access_token_id") REFERENCES "goals"."access_tokens"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goals"."oauth_refresh" ADD CONSTRAINT "oauth_refresh_client_id_oauth_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "goals"."oauth_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "access_tokens_user_id_idx" ON "goals"."access_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE POLICY "access_tokens_select_self" ON "goals"."access_tokens" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((select auth.uid()) = "goals"."access_tokens"."user_id");--> statement-breakpoint
CREATE POLICY "access_tokens_insert_self" ON "goals"."access_tokens" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ((select auth.uid()) = "goals"."access_tokens"."user_id" and "goals"."access_tokens"."kind" = 'personal');--> statement-breakpoint
CREATE POLICY "access_tokens_update_self" ON "goals"."access_tokens" AS PERMISSIVE FOR UPDATE TO "authenticated" USING ((select auth.uid()) = "goals"."access_tokens"."user_id" and "goals"."access_tokens"."revoked_at" is null) WITH CHECK ((select auth.uid()) = "goals"."access_tokens"."user_id");--> statement-breakpoint
CREATE POLICY "oauth_clients_select_all" ON "goals"."oauth_clients" AS PERMISSIVE FOR SELECT TO "authenticated" USING (true);--> statement-breakpoint
CREATE POLICY "oauth_codes_select_self" ON "goals"."oauth_codes" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((select auth.uid()) = "goals"."oauth_codes"."user_id");--> statement-breakpoint
CREATE POLICY "oauth_codes_insert_self" ON "goals"."oauth_codes" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ((select auth.uid()) = "goals"."oauth_codes"."user_id");
--> statement-breakpoint
-- drizzle-kit does not diff a GRANT or a function, so everything below is
-- hand-written, the way 0007's is. Each new table starts from nothing, then
-- takes what it needs. No DELETE anywhere: a key and a connection are revoked.
REVOKE ALL ON TABLE "goals"."access_tokens" FROM "anon", "authenticated", "service_role";
--> statement-breakpoint
ALTER TABLE "goals"."access_tokens" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- `token_hash` is in no column list: the app never reads a fingerprint back.
GRANT SELECT (id, user_id, kind, name, hint, created_at, last_used_at, expires_at, revoked_at) ON TABLE "goals"."access_tokens" TO "authenticated";
--> statement-breakpoint
GRANT INSERT (user_id, name, token_hash, hint) ON TABLE "goals"."access_tokens" TO "authenticated";
--> statement-breakpoint
GRANT UPDATE (revoked_at) ON TABLE "goals"."access_tokens" TO "authenticated";
--> statement-breakpoint
REVOKE ALL ON TABLE "goals"."oauth_clients" FROM "anon", "authenticated", "service_role";
--> statement-breakpoint
ALTER TABLE "goals"."oauth_clients" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT (id, client_name, redirect_uris) ON TABLE "goals"."oauth_clients" TO "authenticated";
--> statement-breakpoint
REVOKE ALL ON TABLE "goals"."oauth_codes" FROM "anon", "authenticated", "service_role";
--> statement-breakpoint
ALTER TABLE "goals"."oauth_codes" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT INSERT (user_id, client_id, code_hash, code_challenge, redirect_uri, resource) ON TABLE "goals"."oauth_codes" TO "authenticated";
--> statement-breakpoint
REVOKE ALL ON TABLE "goals"."oauth_refresh" FROM "anon", "authenticated", "service_role";
--> statement-breakpoint
ALTER TABLE "goals"."oauth_refresh" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- The one place a key becomes a person (RNP-14). Owned by the migrating role,
-- which bypasses RLS; the app connects as that role and no other can execute it.
CREATE FUNCTION "goals"."person_for_token"(hash bytea)
RETURNS TABLE (user_id uuid, email text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  with live as (
    update goals.access_tokens t
       set last_used_at = now()
     where t.token_hash = hash
       and t.revoked_at is null
       and (t.expires_at is null or t.expires_at > now())
    returning t.user_id
  )
  select u.id, u.email::text from live join auth.users u on u.id = live.user_id
$$;
--> statement-breakpoint
-- A client row is public metadata that nobody owns, so registration sweeps the
-- ones nothing ever used. A metadata URL registered again refreshes its row.
CREATE FUNCTION "goals"."oauth_register_client"(name text, uris text[], metadata_url text)
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  with swept as (
    delete from goals.oauth_clients c
     where c.created_at < now() - interval '24 hours'
       and not exists (select 1 from goals.oauth_codes k where k.client_id = c.id)
       and not exists (select 1 from goals.oauth_refresh r where r.client_id = c.id)
  )
  insert into goals.oauth_clients (client_name, redirect_uris, metadata_url)
  values (name, uris, metadata_url)
  on conflict (metadata_url) do update
    set client_name = excluded.client_name, redirect_uris = excluded.redirect_uris
  returning id
$$;
--> statement-breakpoint
CREATE FUNCTION "goals"."oauth_exchange_code"(code_hash bytea, challenge text, client uuid, redirect text, access_hash bytea, refresh_hash bytea)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_variable
declare
  c goals.oauth_codes;
  token uuid;
begin
  select * into c from goals.oauth_codes k where k.code_hash = code_hash for update;
  if not found then
    return null;
  end if;
  if c.used_at is not null then
    update goals.access_tokens t set revoked_at = now()
     where t.id = c.access_token_id and t.revoked_at is null;
    return null;
  end if;
  if c.expires_at <= now() or c.code_challenge <> challenge
     or c.client_id <> client or c.redirect_uri <> redirect then
    return null;
  end if;
  insert into goals.access_tokens (user_id, kind, name, token_hash, expires_at)
  select c.user_id, 'oauth', left(o.client_name, 60), access_hash, now() + interval '1 hour'
    from goals.oauth_clients o where o.id = c.client_id
  returning id into token;
  insert into goals.oauth_refresh (access_token_id, client_id, refresh_hash)
  values (token, c.client_id, refresh_hash);
  update goals.oauth_codes k set used_at = now(), access_token_id = token where k.id = c.id;
  return c.user_id;
end
$$;
--> statement-breakpoint
CREATE FUNCTION "goals"."oauth_refresh_token"(old_refresh bytea, client uuid, access_hash bytea, refresh_hash bytea)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_variable
declare
  r goals.oauth_refresh;
  a goals.access_tokens;
begin
  select * into r from goals.oauth_refresh x where x.refresh_hash = old_refresh and x.client_id = client for update;
  if not found then
    return null;
  end if;
  select * into a from goals.access_tokens t where t.id = r.access_token_id for update;
  if a.revoked_at is not null then
    return null;
  end if;
  if r.used_at is not null then
    update goals.access_tokens t set revoked_at = now() where t.id = a.id;
    return null;
  end if;
  update goals.access_tokens t
     set token_hash = access_hash, expires_at = now() + interval '1 hour'
   where t.id = a.id;
  update goals.oauth_refresh x set used_at = now() where x.id = r.id;
  insert into goals.oauth_refresh (access_token_id, client_id, refresh_hash)
  values (a.id, client, refresh_hash);
  return a.user_id;
end
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "goals"."person_for_token"(bytea) FROM PUBLIC, "anon", "authenticated", "service_role";
--> statement-breakpoint
REVOKE ALL ON FUNCTION "goals"."oauth_register_client"(text, text[], text) FROM PUBLIC, "anon", "authenticated", "service_role";
--> statement-breakpoint
REVOKE ALL ON FUNCTION "goals"."oauth_exchange_code"(bytea, text, uuid, text, bytea, bytea) FROM PUBLIC, "anon", "authenticated", "service_role";
--> statement-breakpoint
REVOKE ALL ON FUNCTION "goals"."oauth_refresh_token"(bytea, uuid, bytea, bytea) FROM PUBLIC, "anon", "authenticated", "service_role";
