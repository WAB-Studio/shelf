CREATE TABLE "goals"."sign_in_claims" (
	"client_key" "bytea" NOT NULL,
	"day" date NOT NULL,
	"count" integer NOT NULL,
	CONSTRAINT "sign_in_claims_client_key_day_pk" PRIMARY KEY("client_key","day"),
	CONSTRAINT "sign_in_claims_count_range" CHECK ("goals"."sign_in_claims"."count" between 1 and 10000)
);
--> statement-breakpoint
ALTER TABLE "goals"."sign_in_claims" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- RP-138, hand-written: drizzle-kit diffs neither a GRANT nor a function. `goals` is a schema Supabase did not make,
-- so no grant arrives at CREATE TABLE; revoked all the same.
REVOKE ALL ON TABLE "goals"."sign_in_claims" FROM "anon", "authenticated", "service_role";
--> statement-breakpoint
ALTER TABLE "goals"."sign_in_claims" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Counts one send for the key on the day and answers whether it fits under `p_cap`. A refusal returns no row from the
-- upsert, so the count stays where it was. Rows two days behind the asked day go on the way.
CREATE FUNCTION "goals"."sign_in_claim"(p_key bytea, p_day date, p_cap integer)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  with swept as (
    delete from goals.sign_in_claims s where s.day < p_day - 2
  ),
  claimed as (
    insert into goals.sign_in_claims (client_key, day, count)
    values (p_key, p_day, 1)
    on conflict (client_key, day) do update
      set count = goals.sign_in_claims.count + 1
      where goals.sign_in_claims.count < p_cap
    returning 1
  )
  select exists (select 1 from claimed)
$$;
--> statement-breakpoint
-- Gives back one send per named key on the day, when Auth refused the code. Two statements, never one with two
-- modifying CTEs on the same rows: a row at 1 goes, then the rows above 1 drop by one.
CREATE FUNCTION "goals"."sign_in_release"(p_keys bytea[], p_day date)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  delete from goals.sign_in_claims s
   where s.day = p_day and s.client_key = any(p_keys) and s.count = 1;
  update goals.sign_in_claims s
     set count = s.count - 1
   where s.day = p_day and s.client_key = any(p_keys) and s.count > 1;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "goals"."sign_in_claim"(bytea, date, integer) FROM PUBLIC, "anon", "authenticated", "service_role";
--> statement-breakpoint
REVOKE ALL ON FUNCTION "goals"."sign_in_release"(bytea[], date) FROM PUBLIC, "anon", "authenticated", "service_role";
