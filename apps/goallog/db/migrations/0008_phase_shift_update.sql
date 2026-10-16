CREATE POLICY "phases_update_self" ON "goals"."phases" AS PERMISSIVE FOR UPDATE TO "authenticated" USING ((select auth.uid()) = "goals"."phases"."user_id") WITH CHECK ((select auth.uid()) = "goals"."phases"."user_id");--> statement-breakpoint
-- drizzle-kit does not diff a GRANT. A phase moves in time with a month shift
-- (RP-34); its aim and goal never change, and it is still never deleted.
GRANT UPDATE (starts_on, ends_on) ON TABLE "goals"."phases" TO "authenticated";
