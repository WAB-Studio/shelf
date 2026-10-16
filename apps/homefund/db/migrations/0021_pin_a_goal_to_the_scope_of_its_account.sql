-- `savings_goals.account_id` carried a plain foreign key and nothing else: `assert_goal_contribution_scope`
-- guards the movement a contribution earmarks, never the account the goal names. The hole was suspected,
-- not proved, so it was opened first — a personal goal naming a group account, and a second naming another
-- person's personal account, each landed one row on the live database under RLS. This closes it. No live
-- goal violates the guard — 0 at the time of writing.
create or replace function private.assert_goal_account_scope() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  a public.accounts;
begin
  -- A goal need name no account at all; only display reads it (RF-77).
  if new.account_id is null then return new; end if;
  select * into a from public.accounts where id = new.account_id;
  if a.owner_user_id is distinct from new.owner_user_id or a.group_id is distinct from new.group_id then
    raise exception 'a goal must name an account of its own scope' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;--> statement-breakpoint
revoke all on function private.assert_goal_account_scope() from public, anon, authenticated, service_role;--> statement-breakpoint
CREATE TRIGGER "savings_goals_assert_account_scope" BEFORE INSERT OR UPDATE ON "savings_goals"
  FOR EACH ROW EXECUTE FUNCTION private.assert_goal_account_scope();
