-- RF-61: `owner_user_id` and `group_id` sit outside every `grant update` on `accounts`, and adding
-- them would let an owner repoint an account into any group — `can_write_account` is stable and
-- reads the OLD row, so the WITH CHECK never sees the new placement. The re-scoping runs here
-- instead, on the caller's own account and into the caller's own group.
-- An account with history is refused: re-scoping a personal movement would force re-scoping its
-- splits, a split's category must share its scope, and a personal category has no group twin to land
-- on. `debt_terms` is left alone — it carries no scope and the account's own gates it.
create or replace function private.hand_account_to_group(p_account uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_group uuid;
  v_account public.accounts;
begin
  select m.group_id into v_group from public.group_members m
    where m.user_id = (select auth.uid()) and m.archived_at is null;
  if not found then
    raise exception 'the caller belongs to no group' using errcode = 'check_violation';
  end if;
  select * into v_account from public.accounts a where a.id = p_account for update;
  if v_account.group_id is not null then
    raise exception 'account % already belongs to a group', p_account using errcode = 'check_violation';
  end if;
  if v_account.id is null or v_account.owner_user_id is distinct from (select auth.uid()) then
    raise exception 'account % is not the caller''s', p_account using errcode = 'check_violation';
  end if;
  if v_account.archived_at is not null then
    raise exception 'account % is archived', p_account using errcode = 'check_violation';
  end if;
  if exists (
    select 1 from public.transactions t
    where t.from_account_id = p_account or t.to_account_id = p_account
  ) or exists (
    select 1 from public.planned_payments p
    where p.from_account_id = p_account or p.to_account_id = p_account
  ) or exists (
    select 1 from public.recurring_rules r
    where r.from_account_id = p_account or r.to_account_id = p_account
  ) or exists (
    select 1 from public.budgets b where b.account_id = p_account
  ) or exists (
    select 1 from public.savings_goals g where g.account_id = p_account
  ) or exists (
    select 1 from public.installment_plans i where i.account_id = p_account
  ) or exists (
    select 1 from public.debt_statements s where s.account_id = p_account
  ) or exists (
    select 1 from public.ingest_deliveries d where d.proposed_account_id = p_account
  ) or exists (
    select 1 from public.webhook_credentials w where w.default_account_id = p_account
  ) then
    raise exception 'account % carries history and is archived, not handed over', p_account using errcode = 'check_violation';
  end if;
  update public.accounts
    set owner_user_id = null, group_id = v_group, is_shared = true
    where id = p_account;
  return true;
end;
$$;--> statement-breakpoint
revoke all on function private.hand_account_to_group(uuid) from public, anon, service_role;--> statement-breakpoint
grant execute on function private.hand_account_to_group(uuid) to authenticated;
