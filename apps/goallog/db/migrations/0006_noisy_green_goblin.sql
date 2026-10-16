-- Widens one_offs_update_self (RP-21): a one-off dated after the person's
-- Bogota today moves too. No table is created here, so there is no REVOKE,
-- and 0005 already grants UPDATE (day), so no GRANT changes.
ALTER POLICY "one_offs_update_self" ON "goals"."one_offs" TO authenticated USING ((select auth.uid()) = "goals"."one_offs"."user_id" and ("goals"."one_offs"."day" is null or "goals"."one_offs"."day" > (now() at time zone 'America/Bogota')::date) and not exists (
        select 1 from "goals"."facts" f where f.one_off_id = "goals"."one_offs"."id"
      )) WITH CHECK ((select auth.uid()) = "goals"."one_offs"."user_id");