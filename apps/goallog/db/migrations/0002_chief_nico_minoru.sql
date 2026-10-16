ALTER POLICY "one_offs_delete_self" ON "goals"."one_offs" TO authenticated USING ((select auth.uid()) = "goals"."one_offs"."user_id" and not exists (
        select 1 from "goals"."facts" f where f.one_off_id = "goals"."one_offs"."id"
      ));