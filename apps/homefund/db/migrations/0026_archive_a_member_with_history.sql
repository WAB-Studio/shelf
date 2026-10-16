-- RF-11: `group_members_delete_member` let the leader drop anyone but herself, and nothing tied a
-- roster row to the record. Removing a person who had recorded movements left that history naming
-- someone on no roster. The trace is read wide — the person's user created a movement, owns one, or
-- owns an account — and any one of them makes archiving the only way out.
create or replace function private.assert_member_without_history() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  -- A row no one ever claimed carries no user to have acted as.
  if old.user_id is null then return old; end if;
  -- The group itself is gone: the cascade took its roster with it, which is legal.
  if not exists (select 1 from public.groups g where g.id = old.group_id) then return old; end if;
  if exists (
    select 1 from public.transactions t
    where t.created_by = old.user_id or t.owner_user_id = old.user_id
  ) or exists (
    select 1 from public.accounts a where a.owner_user_id = old.user_id
  ) then
    raise exception 'member % has history and can only be archived', old.id using errcode = 'check_violation';
  end if;
  return old;
end;
$$;--> statement-breakpoint
revoke all on function private.assert_member_without_history() from public, anon, authenticated, service_role;--> statement-breakpoint
CREATE TRIGGER "group_members_assert_without_history" BEFORE DELETE ON "group_members"
  FOR EACH ROW EXECUTE FUNCTION private.assert_member_without_history();
