-- A member's `is_shared = false` on a group account leaves `can_write_account` false for everyone, leader
-- included, and nothing in the app undoes it. The toggle is the leader's alone. A trigger carries it
-- because the WITH CHECK of `accounts_update_writable` reads the OLD row through a security-definer
-- function and never sees the new value. A session with no `auth.uid()` (the owner role, a migration) passes.
create or replace function private.assert_leader_toggles_sharing() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.group_id is not null
     and new.is_shared is distinct from old.is_shared
     and (select auth.uid()) is not null
     and not private.is_group_leader(old.group_id) then
    raise exception 'only the group''s leader changes whether a group account is shared' using errcode = '42501';
  end if;
  return new;
end;
$$;--> statement-breakpoint
revoke all on function private.assert_leader_toggles_sharing() from public, anon, authenticated, service_role;--> statement-breakpoint
create trigger accounts_leader_toggles_sharing before update of is_shared on finances.accounts
  for each row execute function private.assert_leader_toggles_sharing();
--> statement-breakpoint
-- The leader undoes an un-share: `can_write_account` is false for an unshared group account, so
-- `accounts_update_writable` cannot admit the re-share. Only an unshared row, only the leader's group.
CREATE POLICY "accounts_update_leader_reshare" ON "finances"."accounts" AS PERMISSIVE FOR UPDATE TO "authenticated" USING (("finances"."accounts"."group_id" is not null and not "finances"."accounts"."is_shared" and (select private.is_group_leader("finances"."accounts"."group_id")))) WITH CHECK (("finances"."accounts"."group_id" is not null and (select private.is_group_leader("finances"."accounts"."group_id"))));
