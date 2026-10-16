-- A one-off is done once (RP-19, RP-22). Production held no duplicate on 2026-10-08;
-- the dedupe stays because a migration's dedupe is only as safe as the day it was measured.
-- It refuses to drop a note the kept fact lacks: one run of this file aborts, the
-- migrator rolls the whole transaction back and the database stays on 0014.
DO $$
DECLARE
  clashes integer;
BEGIN
  -- A fact the DELETE below would remove, whose note the kept fact does not carry.
  SELECT count(DISTINCT r."one_off_id") INTO clashes FROM (
    SELECT "one_off_id", "note",
      row_number() OVER (PARTITION BY "one_off_id" ORDER BY "day", "written_at", "id") AS n,
      first_value("note") OVER (PARTITION BY "one_off_id" ORDER BY "day", "written_at", "id") AS kept_note
    FROM "goals"."facts"
    WHERE "one_off_id" IS NOT NULL
  ) r
  WHERE r.n > 1 AND r."note" IS NOT NULL AND r."note" IS DISTINCT FROM r.kept_note;
  IF clashes > 0 THEN
    RAISE EXCEPTION '0015: % one-off(s) hold a duplicate fact whose note would be lost; resolve them by hand before migrating', clashes;
  END IF;
END
$$;
--> statement-breakpoint
-- Keeps the oldest fact of each one-off, by the day `done_on` already reads (min(day)).
DELETE FROM "goals"."facts" f
USING (
  SELECT "id", row_number() OVER (PARTITION BY "one_off_id" ORDER BY "day", "written_at", "id") AS n
  FROM "goals"."facts"
  WHERE "one_off_id" IS NOT NULL
) ranked
WHERE f."id" = ranked."id" AND ranked.n > 1;
--> statement-breakpoint
CREATE UNIQUE INDEX "facts_one_off_unique" ON "goals"."facts" USING btree ("one_off_id") WHERE "goals"."facts"."one_off_id" is not null;
--> statement-breakpoint
-- RP-34 and RP-48 retire: a shift of the plan is no longer an act with its own table.
ALTER TABLE "goals"."month_shifts" DISABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY "month_shifts_select_self" ON "goals"."month_shifts" CASCADE;
--> statement-breakpoint
DROP POLICY "month_shifts_insert_self" ON "goals"."month_shifts" CASCADE;
--> statement-breakpoint
DROP TABLE "goals"."month_shifts" CASCADE;
--> statement-breakpoint
REVOKE UPDATE ("starts_on", "ends_on") ON TABLE "goals"."phases" FROM "authenticated";
--> statement-breakpoint
DROP POLICY "phases_update_self" ON "goals"."phases" CASCADE;
--> statement-breakpoint
-- No DELETE grant backs these three: they do nothing today and would open a delete the day one is given.
DROP POLICY "goals_delete_self" ON "goals"."goals" CASCADE;
--> statement-breakpoint
DROP POLICY "phases_delete_self" ON "goals"."phases" CASCADE;
--> statement-breakpoint
DROP POLICY "commitments_delete_self" ON "goals"."commitments" CASCADE;
--> statement-breakpoint
-- A key that sat unused for 90 days no longer opens; the row is not revoked. A key never used counts from its creation.
CREATE OR REPLACE FUNCTION "goals"."person_for_token"(hash bytea)
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
       and coalesce(t.last_used_at, t.created_at) > now() - interval '90 days'
    returning t.user_id
  )
  select u.id, u.email::text from live join auth.users u on u.id = live.user_id
$$;
--> statement-breakpoint
-- Every use past the first hour goes through a refresh, so the refresh's age is the age of the last use.
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
-- Reads a registered client without registering: spends no throttle slot (RNP-19).
CREATE FUNCTION "goals"."oauth_client_by_metadata_url"(url text)
RETURNS TABLE (id uuid, client_name text, redirect_uris text[])
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  select c.id, c.client_name, c.redirect_uris
    from goals.oauth_clients c
   where c.metadata_url = url
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "goals"."person_for_token"(bytea) FROM PUBLIC, "anon", "authenticated", "service_role";
--> statement-breakpoint
REVOKE ALL ON FUNCTION "goals"."oauth_refresh_token"(bytea, uuid, bytea, bytea) FROM PUBLIC, "anon", "authenticated", "service_role";
--> statement-breakpoint
REVOKE ALL ON FUNCTION "goals"."oauth_client_by_metadata_url"(text) FROM PUBLIC, "anon", "authenticated", "service_role";
