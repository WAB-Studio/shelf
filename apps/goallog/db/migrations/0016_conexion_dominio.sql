ALTER TABLE "goals"."access_tokens" ADD COLUMN "redirect_uri" text;
--> statement-breakpoint
-- drizzle-kit does not diff a grant or a function; everything below is hand-written, as in 0009 and 0015.
-- The owner reads the address; nobody writes it. Only the exchange below puts it there.
GRANT SELECT ("redirect_uri") ON TABLE "goals"."access_tokens" TO "authenticated";
--> statement-breakpoint
-- Same body as 0009 plus the address the person approved.
CREATE OR REPLACE FUNCTION "goals"."oauth_exchange_code"(code_hash bytea, challenge text, client uuid, redirect text, access_hash bytea, refresh_hash bytea)
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
  insert into goals.access_tokens (user_id, kind, name, token_hash, expires_at, redirect_uri)
  select c.user_id, 'oauth', left(o.client_name, 60), access_hash, now() + interval '1 hour', c.redirect_uri
    from goals.oauth_clients o where o.id = c.client_id
  returning id into token;
  insert into goals.oauth_refresh (access_token_id, client_id, refresh_hash)
  values (token, c.client_id, refresh_hash);
  update goals.oauth_codes k set used_at = now(), access_token_id = token where k.id = c.id;
  return c.user_id;
end
$$;
--> statement-breakpoint
UPDATE "goals"."access_tokens" t SET "redirect_uri" = k."redirect_uri" FROM "goals"."oauth_codes" k WHERE k."access_token_id" = t."id" AND t."kind" = 'oauth';
--> statement-breakpoint
-- When a key stops opening: the one rule `person_for_token` and `oauth_refresh_token` apply, written once for the list.
-- An OAuth connection's last refresh is its `expires_at` minus the hour it was granted.
CREATE OR REPLACE FUNCTION "goals"."access_token_lapses_at"(kind text, last_used_at timestamptz, created_at timestamptz, expires_at timestamptz, revoked_at timestamptz)
RETURNS timestamptz
LANGUAGE sql
IMMUTABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  select case
    when revoked_at is not null then null
    when kind = 'oauth' then expires_at - interval '1 hour' + interval '90 days'
    else coalesce(last_used_at, created_at) + interval '90 days'
  end
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "goals"."access_token_lapses_at"(text, timestamptz, timestamptz, timestamptz, timestamptz) FROM PUBLIC, "anon", "service_role";
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "goals"."access_token_lapses_at"(text, timestamptz, timestamptz, timestamptz, timestamptz) TO "authenticated";
