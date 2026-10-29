-- 0027 read the account by id alone, so the message told any caller whether an id existed and
-- whether it was a group account, and the `for update` on that first read let a caller hold a lock on
-- a row belonging to someone else. The lookup now carries the caller's own reach in its predicate:
-- the row is locked only when the caller owns it, and everything outside that reach answers with the
-- same refusal, whether it is another person's account, another group's, or no row at all.
-- `accounts_owner_xor_group` leaves a group account with a null owner, so an ownership-first test
-- would swallow "already belongs to a group". It is kept, bounded to the caller's own group — the
-- one group account `accounts_select_group` already shows them, so the message discloses nothing a
-- plain select does not.
create or replace function private.hand_account_to_group(p_account uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := (select auth.uid());
  v_group uuid;
  v_account public.accounts;
begin
  select m.group_id into v_group from public.group_members m
    where m.user_id = v_user and m.archived_at is null;
  if not found then
    raise exception 'the caller belongs to no group' using errcode = 'check_violation';
  end if;
  select * into v_account from public.accounts a
    where a.id = p_account and a.owner_user_id = v_user
    for update;
  if v_account.id is null then
    if exists (select 1 from public.accounts a where a.id = p_account and a.group_id = v_group) then
      raise exception 'account % already belongs to a group', p_account using errcode = 'check_violation';
    end if;
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
$$;
