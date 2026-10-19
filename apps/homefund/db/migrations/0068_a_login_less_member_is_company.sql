-- A member recorded without a login is someone in the fund. 0066 counted only a member with a login or a pending
-- invitation, so a leader whose fund held a login-less member was "alone": she could leave and orphan that member.
-- "Alone" now means no other live row of any kind in the fund; the leader guard lets a fund stand leaderless on the
-- same terms. Every other line of the two bodies is 0066's. Hand-written: the snapshot chain forks at 0052-0054.
CREATE OR REPLACE FUNCTION "private"."accept_group_invitation"(p_member uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
declare
  v_user uuid := auth.uid();
  v_email text := auth.email();
  v_row finances.group_members;
  v_own finances.group_members;
begin
  if v_user is null or v_email is null then return 'gone'; end if;
  select * into v_row from finances.group_members m
    where m.id = p_member
      and m.invite_state = 'pending'
      and m.user_id is null
      and m.archived_at is null
      and m.invite_email is not null
      and pg_catalog.lower(m.invite_email) = pg_catalog.lower(v_email)
    for update;
  if not found then return 'gone'; end if;
  -- Locked before deciding, so two accepts by the same person queue and the second finds her row archived.
  select * into v_own from finances.group_members m
    where m.user_id = v_user and m.archived_at is null
    for update;
  if found and not (
    v_own.role = 'leader'
    and not exists (
      select 1 from finances.group_members o
      where o.group_id = v_own.group_id
        and o.id <> v_own.id
        and o.archived_at is null
    )
  ) then
    return 'otherFund';
  end if;
  begin
    if v_own.id is not null then
      update finances.group_members m set archived_at = pg_catalog.now() where m.id = v_own.id;
    end if;
    update finances.group_members m
      set user_id = v_user, invite_email = null, invite_state = 'accepted'
      where m.id = v_row.id;
  exception when unique_violation then
    return 'otherFund';
  end;
  return 'accepted';
end;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION private.assert_group_keeps_leader()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  -- The group itself is gone: the cascade took its members with it, which is legal.
  if not exists (select 1 from finances.groups g where g.id = old.group_id) then return null; end if;
  if not exists (
    select 1 from finances.group_members m
    where m.group_id = old.group_id and m.role = 'leader' and m.archived_at is null
  ) and exists (
    select 1 from finances.group_members m
    where m.group_id = old.group_id and m.archived_at is null
  ) then
    raise exception 'group % would be left without a leader', old.group_id using errcode = 'check_violation';
  end if;
  return null;
end;
$function$;
