ALTER POLICY "audit_log_select_scope" ON "audit_log" TO authenticated USING (("audit_log"."owner_user_id" = (select auth.uid()) or "audit_log"."actor_user_id" = (select auth.uid()) or "audit_log"."group_id" in (
        select "group_members"."group_id" from "group_members"
        where "group_members"."user_id" = (select auth.uid()) and "group_members"."archived_at" is null
      )));