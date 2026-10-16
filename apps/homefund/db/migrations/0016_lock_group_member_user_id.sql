-- `grant update (user_id, invite_email)` served the invite claim, but a grant is table-wide across
-- every UPDATE policy, and `group_members_update_member` admits every row in the group. A plain
-- member could repoint the leader's `user_id` at a uuid of their own: `is_group_member()` went false
-- for her, the row kept `role = 'leader'`, and the attacker's second account inherited the group and
-- every member's personal accounts. `user_id` is now writable on INSERT only.
DROP POLICY "group_members_update_claim" ON "group_members" CASCADE;--> statement-breakpoint
REVOKE UPDATE ON TABLE "group_members" FROM authenticated;--> statement-breakpoint
-- `invite_email` stays writable: a member re-import rewrites it (RF-51).
GRANT UPDATE (name, archived_at, invite_email) ON TABLE "group_members" TO authenticated;--> statement-breakpoint
-- RF-06 without a target: the caller names no row, so a claim cannot be aimed. The row is picked from
-- the email the caller's magic link proved, oldest first, and locked so two sessions cannot take the
-- same one. Returns the claimed id, or null when the caller has no pending invite.
create or replace function private.claim_group_invite() returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_email text := auth.email();
  v_id uuid;
begin
  if v_user is null or v_email is null then return null; end if;
  select m.id into v_id from public.group_members m
    where m.user_id is null
      and m.invite_email is not null
      and m.archived_at is null
      and pg_catalog.lower(m.invite_email) = pg_catalog.lower(v_email)
    order by m.created_at, m.id
    limit 1
    for update;
  if v_id is null then return null; end if;
  update public.group_members m
    set user_id = v_user, invite_email = null
    where m.id = v_id;
  return v_id;
end;
$$;--> statement-breakpoint
revoke all on function private.claim_group_invite() from public, anon, authenticated, service_role;--> statement-breakpoint
-- The session calls it directly on first sign-in.
grant execute on function private.claim_group_invite() to authenticated;
