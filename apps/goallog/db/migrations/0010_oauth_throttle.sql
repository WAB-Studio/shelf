CREATE TABLE "goals"."oauth_calls" (
	"bucket" text NOT NULL,
	"source" "bytea" NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"calls" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "oauth_calls_bucket_source_window_start_pk" PRIMARY KEY("bucket","source","window_start"),
	CONSTRAINT "oauth_calls_bucket_known" CHECK ("goals"."oauth_calls"."bucket" in ('register', 'token'))
);
--> statement-breakpoint
ALTER TABLE "goals"."oauth_calls" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
-- drizzle-kit does not diff a GRANT or a function, so what follows is
-- hand-written, the way 0009's is. The table starts from nothing and takes
-- nothing: only `oauth_claim_call` writes it.
REVOKE ALL ON TABLE "goals"."oauth_calls" FROM "anon", "authenticated", "service_role";
--> statement-breakpoint
ALTER TABLE "goals"."oauth_calls" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Counts one call in the address's current window and returns 0 while it is
-- within `cap`, else the whole seconds left in the window. Parameters carry a
-- prefix because a column of the same name would win inside a SQL function.
CREATE FUNCTION "goals"."oauth_claim_call"(p_bucket text, p_source bytea, p_cap integer, p_window_seconds integer)
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  with swept as (
    delete from goals.oauth_calls o where o.window_start < now() - interval '1 day'
  ),
  slot as (
    select date_bin(make_interval(secs => p_window_seconds), now(), timestamptz 'epoch') as starts
  ),
  claimed as (
    insert into goals.oauth_calls (bucket, source, window_start)
    select p_bucket, p_source, slot.starts from slot
    on conflict (bucket, source, window_start)
    do update set calls = goals.oauth_calls.calls + 1
    returning calls, window_start
  )
  select case
    when claimed.calls <= p_cap then 0
    else greatest(1, ceil(extract(epoch from claimed.window_start + make_interval(secs => p_window_seconds) - now()))::integer)
  end
  from claimed
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "goals"."oauth_claim_call"(text, bytea, integer, integer) FROM PUBLIC, "anon", "authenticated", "service_role";
--> statement-breakpoint
-- Adds the ceiling on unused clients: all but the newest 99 go, so the row
-- inserted here makes 100. A client with a code or a refresh row is never
-- dropped, nor is the row a repeated metadata URL is about to refresh.
CREATE OR REPLACE FUNCTION "goals"."oauth_register_client"(name text, uris text[], metadata_url text)
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
  ),
  evicted as (
    delete from goals.oauth_clients c
     where c.id in (
       select u.id from goals.oauth_clients u
        where not exists (select 1 from goals.oauth_codes k where k.client_id = u.id)
          and not exists (select 1 from goals.oauth_refresh r where r.client_id = u.id)
        order by u.created_at desc, u.id
        offset 99
     )
       and ($3 is null or c.metadata_url is distinct from $3)
  )
  insert into goals.oauth_clients (client_name, redirect_uris, metadata_url)
  values (name, uris, metadata_url)
  on conflict (metadata_url) do update
    set client_name = excluded.client_name, redirect_uris = excluded.redirect_uris
  returning id
$$;
