-- drizzle-kit does not diff a function; everything below is hand-written, as in 0015 and 0016.
-- A second use inside 30 s is the client's retry or race: refuse it and keep the pair the first use returned.
-- Past the window it is a replay and kills the connection, as before (Q22 a).
CREATE OR REPLACE FUNCTION "goals"."oauth_refresh_token"(old_refresh bytea, client uuid, access_hash bytea, refresh_hash bytea)
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
  if r.created_at <= now() - interval '90 days' then
    return null;
  end if;
  select * into a from goals.access_tokens t where t.id = r.access_token_id for update;
  if a.revoked_at is not null then
    return null;
  end if;
  if r.used_at is not null then
    if r.used_at > now() - interval '30 seconds' then
      return null;
    end if;
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
    if c.used_at > now() - interval '30 seconds' then
      return null;
    end if;
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
REVOKE ALL ON FUNCTION "goals"."oauth_refresh_token"(bytea, uuid, bytea, bytea) FROM PUBLIC, "anon", "authenticated", "service_role";
--> statement-breakpoint
REVOKE ALL ON FUNCTION "goals"."oauth_exchange_code"(bytea, text, uuid, text, bytea, bytea) FROM PUBLIC, "anon", "authenticated", "service_role";
