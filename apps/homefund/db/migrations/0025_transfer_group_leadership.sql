-- RF-59: nothing in the product moved the leader role. A `grant update (role)` cannot serve it —
-- `group_members_update_member` admits a member's own live row, so the column would let any member
-- promote herself. The move lives here instead, as one call that reads the caller from the session
-- and can never be aimed at the caller's own row. The demotion rides along: a group holds exactly
-- one leader, and `group_members_keep_leader` sees the pair at commit.
create or replace function private.transfer_group_leadership(p_member uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_self public.group_members;
  v_target public.group_members;
begin
  select * into v_self from public.group_members m
    where m.user_id = (select auth.uid()) and m.archived_at is null
    for update;
  if not found then
    raise exception 'the caller belongs to no group' using errcode = 'check_violation';
  end if;
  if v_self.role <> 'leader' then
    raise exception 'only the leader transfers the role' using errcode = 'check_violation';
  end if;
  select * into v_target from public.group_members m
    where m.id = p_member and m.group_id = v_self.group_id
    for update;
  if not found then
    raise exception 'member % is not in the leader''s group', p_member using errcode = 'check_violation';
  end if;
  if v_target.archived_at is not null then
    raise exception 'member % is archived and cannot lead', p_member using errcode = 'check_violation';
  end if;
  if v_target.user_id is null then
    raise exception 'member % has no login and cannot lead', p_member using errcode = 'check_violation';
  end if;
  if v_target.id = v_self.id then
    raise exception 'the leader already holds the role' using errcode = 'check_violation';
  end if;
  update public.group_members set role = 'leader' where id = v_target.id;
  update public.group_members set role = 'member' where id = v_self.id;
  return true;
end;
$$;--> statement-breakpoint
revoke all on function private.transfer_group_leadership(uuid) from public, anon, service_role;--> statement-breakpoint
grant execute on function private.transfer_group_leadership(uuid) to authenticated;
