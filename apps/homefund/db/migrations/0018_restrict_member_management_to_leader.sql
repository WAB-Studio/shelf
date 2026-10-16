-- `group_members_delete_member` and `group_members_update_member` admitted every row in the group,
-- so a plain member could archive or remove any other member, the leader included: proved on the
-- live database as UPDATE 1 and DELETE 1 against the leader's row, with only the deferred
-- `assert_group_keeps_leader` standing between it and a group with no leader at all. RF-100 gives
-- adding, renaming, archiving, restoring and removing to the leader alone; a member reaches their
-- own live row, where the grant and the last WITH CHECK conjunct leave nothing but `name`.
ALTER POLICY "group_members_insert_member" ON "group_members" TO authenticated WITH CHECK ((select private.is_group_leader("group_members"."group_id")) and "group_members"."user_id" is null and "group_members"."role" = 'member');--> statement-breakpoint
ALTER POLICY "group_members_update_member" ON "group_members" TO authenticated USING ((select private.is_group_leader("group_members"."group_id")) or ("group_members"."user_id" = (select auth.uid()) and "group_members"."archived_at" is null)) WITH CHECK (((select private.is_group_leader("group_members"."group_id")) or "group_members"."user_id" = (select auth.uid())) and ("group_members"."user_id" is distinct from (select auth.uid()) or "group_members"."archived_at" is null));--> statement-breakpoint
ALTER POLICY "group_members_delete_member" ON "group_members" TO authenticated USING ((select private.is_group_leader("group_members"."group_id")) and "group_members"."user_id" is distinct from (select auth.uid()));
