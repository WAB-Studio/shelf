CREATE POLICY "audit_log_select_scope" ON "audit_log" AS PERMISSIVE FOR SELECT TO "authenticated" USING (("audit_log"."owner_user_id" = (select auth.uid()) or ("audit_log"."group_id" is not null and (select private.is_group_member("audit_log"."group_id"))) or "audit_log"."actor_user_id" = (select auth.uid())));--> statement-breakpoint
-- SELECT and only SELECT: the read-only viewer (RF-53) needs the privilege the policy alone cannot
-- supply, while INSERT/UPDATE/DELETE stay barred for every user role and the log stays append-only to
-- the definer trigger (RF-44).
GRANT SELECT ON TABLE "audit_log" TO authenticated;