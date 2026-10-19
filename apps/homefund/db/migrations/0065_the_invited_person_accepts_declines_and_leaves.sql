-- RF-154: acceptance, refusal and leaving are the person's own act, each one a server function of its own.
-- No role holds a column grant on `user_id` or `invite_state`, and the update policy refuses a member
-- archiving her own row, so a definer function is the only door. Each reads the caller from the session;
-- none takes a user id or an address. The invitee is matched by the verified email Auth holds.
-- Hand-written: the snapshot chain forks at 0052-0054, so drizzle-kit cannot generate from it.
CREATE FUNCTION "private"."accept_group_invitation"(p_member uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
declare
  v_user uuid := auth.uid();
  v_email text := auth.email();
  v_row finances.group_members;
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
  if exists (select 1 from finances.group_members m where m.user_id = v_user and m.archived_at is null) then
    return 'otherFund';
  end if;
  begin
    update finances.group_members m
      set user_id = v_user, invite_email = null, invite_state = 'accepted'
      where m.id = v_row.id;
  exception when unique_violation then
    return 'otherFund';
  end;
  return 'accepted';
end;
$$;--> statement-breakpoint
CREATE FUNCTION "private"."decline_group_invitation"(p_member uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
declare
  v_email text := auth.email();
  v_id uuid;
begin
  if auth.uid() is null or v_email is null then return 'gone'; end if;
  select m.id into v_id from finances.group_members m
    where m.id = p_member
      and m.invite_state = 'pending'
      and m.user_id is null
      and m.archived_at is null
      and m.invite_email is not null
      and pg_catalog.lower(m.invite_email) = pg_catalog.lower(v_email)
    for update;
  if v_id is null then return 'gone'; end if;
  update finances.group_members m
    set invite_state = 'declined', archived_at = pg_catalog.now()
    where m.id = v_id;
  return 'declined';
end;
$$;--> statement-breakpoint
-- The membership is archived, never deleted: what the person wrote in the fund keeps naming her. A leader
-- stays, alone or not, so a fund is never left without one.
CREATE FUNCTION "private"."leave_group"() RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
declare
  v_row finances.group_members;
begin
  if auth.uid() is null then return 'notInFund'; end if;
  select * into v_row from finances.group_members m
    where m.user_id = auth.uid() and m.archived_at is null
    for update;
  if not found then return 'notInFund'; end if;
  if v_row.role = 'leader' then return 'leaderStays'; end if;
  update finances.group_members m set archived_at = pg_catalog.now() where m.id = v_row.id;
  return 'left';
end;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "private"."accept_group_invitation"(uuid) FROM public, anon, authenticated, service_role;--> statement-breakpoint
REVOKE ALL ON FUNCTION "private"."decline_group_invitation"(uuid) FROM public, anon, authenticated, service_role;--> statement-breakpoint
REVOKE ALL ON FUNCTION "private"."leave_group"() FROM public, anon, authenticated, service_role;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "private"."accept_group_invitation"(uuid) TO authenticated;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "private"."decline_group_invitation"(uuid) TO authenticated;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "private"."leave_group"() TO authenticated;
