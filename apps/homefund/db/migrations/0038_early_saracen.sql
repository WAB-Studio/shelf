-- Reverts 0037. Measured there: rewriting the group branch as `group_id in (select ...)` compiles to
-- `= any(hashed SubPlan)`, which cannot join the `BitmapOr` the other two branches plan through their
-- indexes, so Postgres drops the whole `or` back to a Seq Scan — the trap 0036's index was meant to
-- close. The 0010 form, `is_group_member(group_id)` and all, is what actually plans a `BitmapOr` once
-- 0036's actor index exists; the explain plans are in `docs/TRAPS.md`.
ALTER POLICY "audit_log_select_scope" ON "audit_log" TO authenticated USING (("audit_log"."owner_user_id" = (select auth.uid()) or ("audit_log"."group_id" is not null and (select private.is_group_member("audit_log"."group_id"))) or "audit_log"."actor_user_id" = (select auth.uid())));