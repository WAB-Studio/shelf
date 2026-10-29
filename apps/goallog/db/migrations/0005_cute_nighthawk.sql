CREATE POLICY "one_offs_update_self" ON "goals"."one_offs" AS PERMISSIVE FOR UPDATE TO "authenticated" USING ((select auth.uid()) = "goals"."one_offs"."user_id" and "goals"."one_offs"."day" is null and not exists (
        select 1 from "goals"."facts" f where f.one_off_id = "goals"."one_offs"."id"
      )) WITH CHECK ((select auth.uid()) = "goals"."one_offs"."user_id");
--> statement-breakpoint
-- drizzle-kit does not diff a GRANT, so these two are hand-written, the way
-- 0001's are. No table is created here, so there is no REVOKE: nothing new
-- for Supabase to have auto-granted. A one-off takes a day (RP-21) and a
-- goal's horizon moves (RP-25); no other column changes grant.
GRANT UPDATE (day) ON TABLE "goals"."one_offs" TO "authenticated";
--> statement-breakpoint
GRANT UPDATE (horizon) ON TABLE "goals"."goals" TO "authenticated";
