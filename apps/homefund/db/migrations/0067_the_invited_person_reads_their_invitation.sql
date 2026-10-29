-- RF-154: the invited person reads the invitation addressed to them. A pending row has no user and its fund
-- is not theirs, so no policy admits the read; a definer function is the only door, as for accepting.
-- It takes no argument: the caller is auth.uid() and the address auth.email(), both from the verified
-- session. At most one row: the oldest live pending invitation. `current_fund_name` is the fund the caller
-- already lives in (null when none); `current_fund_has_company` is true when another live row is there
-- (a member, with a login or not, or a pending invitation): a person alone in their own fund may still accept (Q32).
-- Hand-written: the snapshot chain forks at 0052-0054, so drizzle-kit cannot generate from it.
CREATE FUNCTION "private"."pending_invitation"()
RETURNS TABLE (member_id uuid, inviter_name text, fund_name text, current_fund_name text, current_fund_has_company boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  select m.id,
    coalesce(
      (select l.name from finances.group_members l
        where l.group_id = m.group_id and l.role = 'leader' and l.archived_at is null
        order by l.created_at, l.id limit 1),
      ''),
    g.name,
    (select og.name from finances.group_members mine
      join finances.groups og on og.id = mine.group_id
      where mine.user_id = auth.uid() and mine.archived_at is null limit 1),
    exists (
      select 1 from finances.group_members mine
      join finances.group_members o on o.group_id = mine.group_id and o.id <> mine.id
      where mine.user_id = auth.uid() and mine.archived_at is null and o.archived_at is null)
  from finances.group_members m
  join finances.groups g on g.id = m.group_id
  where auth.uid() is not null
    and auth.email() is not null
    and m.invite_state = 'pending'
    and m.archived_at is null
    and m.user_id is null
    and m.invite_email is not null
    and pg_catalog.lower(m.invite_email) = pg_catalog.lower(auth.email())
  order by m.created_at, m.id
  limit 1;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "private"."pending_invitation"() FROM public, anon, authenticated, service_role;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "private"."pending_invitation"() TO authenticated;
