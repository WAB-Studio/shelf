ALTER TABLE "goal_contributions" ALTER COLUMN "transaction_id" DROP NOT NULL;--> statement-breakpoint
create or replace function private.assert_goal_contribution_scope() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  g public.savings_goals;
  t public.transactions;
begin
  -- A virtual contribution earmarks no movement, so it has no scope to match (RF-77).
  if new.transaction_id is null then
    return new;
  end if;
  select * into g from public.savings_goals where id = new.goal_id;
  select * into t from public.transactions where id = new.transaction_id;
  -- A contribution earmarks a movement that shares the goal's scope (RF-77).
  if g.owner_user_id is distinct from t.owner_user_id or g.group_id is distinct from t.group_id then
    raise exception 'a contribution must share its goal''s scope' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;--> statement-breakpoint
revoke all on function private.assert_goal_contribution_scope() from public, anon, authenticated, service_role;