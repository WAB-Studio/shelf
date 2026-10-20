CREATE TABLE "goals"."write_receipts" (
	"user_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"act" text NOT NULL,
	"answer" jsonb NOT NULL,
	"made_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "write_receipts_user_id_request_id_pk" PRIMARY KEY("user_id","request_id")
);
--> statement-breakpoint
ALTER TABLE "goals"."write_receipts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "goals"."write_receipts" ADD CONSTRAINT "write_receipts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "write_receipts_select_self" ON "goals"."write_receipts" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((select auth.uid()) = "goals"."write_receipts"."user_id");--> statement-breakpoint
CREATE POLICY "write_receipts_insert_self" ON "goals"."write_receipts" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ((select auth.uid()) = "goals"."write_receipts"."user_id");--> statement-breakpoint
-- RP-56, RNP-05, hand-written: drizzle-kit diffs neither a GRANT nor a function. `goals` is a schema Supabase did not
-- make, so no grant arrives at CREATE TABLE; revoked all the same.
REVOKE ALL ON TABLE "goals"."write_receipts" FROM "anon", "authenticated", "service_role";
--> statement-breakpoint
GRANT SELECT ON TABLE "goals"."write_receipts" TO "authenticated";
--> statement-breakpoint
-- `made_at` is left out: a receipt dated by hand would dodge or hasten its own prune.
GRANT INSERT (user_id, request_id, act, answer) ON TABLE "goals"."write_receipts" TO "authenticated";
--> statement-breakpoint
-- The caller's own receipts older than 7 days, and nobody else's: the person is `auth.uid()`, never a parameter.
-- Definer because `authenticated` holds no DELETE on the table.
CREATE FUNCTION "goals"."prune_write_receipts"()
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  with gone as (
    delete from goals.write_receipts r
     where r.user_id = (select auth.uid()) and r.made_at < now() - interval '7 days'
    returning 1
  )
  select count(*)::integer from gone
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "goals"."prune_write_receipts"() FROM PUBLIC, "anon", "authenticated", "service_role";
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "goals"."prune_write_receipts"() TO "authenticated";
