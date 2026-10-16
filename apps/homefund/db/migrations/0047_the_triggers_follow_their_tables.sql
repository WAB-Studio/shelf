CREATE OR REPLACE FUNCTION private.assert_budget_scope()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  c finances.categories;
  a finances.accounts;
  l finances.labels;
begin
  select * into c from finances.categories where id = new.category_id;
  -- A budget caps spending, so it names an expense category (RF-71).
  if c.kind <> 'expense' then
    raise exception 'a budget names an expense category' using errcode = 'check_violation';
  end if;
  if c.owner_user_id is distinct from new.owner_user_id or c.group_id is distinct from new.group_id then
    raise exception 'a budget category must share the budget''s scope' using errcode = 'check_violation';
  end if;
  -- The optional account narrowing stays within the budget's own scope.
  if new.account_id is not null then
    select * into a from finances.accounts where id = new.account_id;
    if a.owner_user_id is distinct from new.owner_user_id or a.group_id is distinct from new.group_id then
      raise exception 'a budget account must share the budget''s scope' using errcode = 'check_violation';
    end if;
  end if;
  -- The optional label narrowing stays within the budget's own scope.
  if new.label_id is not null then
    select * into l from finances.labels where id = new.label_id;
    if l.owner_user_id is distinct from new.owner_user_id or l.group_id is distinct from new.group_id then
      raise exception 'a budget label must share the budget''s scope' using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION private.assert_category_depth()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  parent finances.categories;
begin
  if new.parent_id is null then return new; end if;
  if new.parent_id = new.id then
    raise exception 'a category cannot be its own parent' using errcode = 'check_violation';
  end if;
  if exists (select 1 from finances.categories c where c.parent_id = new.id) then
    raise exception 'category % already has children and cannot become one', new.id using errcode = 'check_violation';
  end if;
  select * into parent from finances.categories c where c.id = new.parent_id;
  -- The foreign key skipped the pair, so existence is this function's to establish.
  if not found then
    raise exception 'the parent category does not exist' using errcode = 'check_violation';
  end if;
  if parent.owner_user_id is distinct from new.owner_user_id or parent.group_id is distinct from new.group_id then
    raise exception 'a subcategory must share its parent''s scope' using errcode = 'check_violation';
  end if;
  if parent.parent_id is not null then
    raise exception 'nesting stops at one level' using errcode = 'check_violation';
  end if;
  if parent.kind <> new.kind then
    raise exception 'a subcategory must share its parent''s kind' using errcode = 'check_violation';
  end if;
  return new;
end;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION private.assert_debt_terms_liability()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  a finances.accounts;
begin
  select * into a from finances.accounts where id = new.account_id;
  -- A debt profile only fits a liability account (RF-78).
  if a.kind <> 'liability' then
    raise exception 'debt terms attach to a liability account' using errcode = '23514';
  end if;
  return new;
end;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION private.assert_goal_account_scope()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  a finances.accounts;
begin
  -- A goal need name no account at all; only display reads it (RF-77).
  if new.account_id is null then return new; end if;
  select * into a from finances.accounts where id = new.account_id;
  if a.owner_user_id is distinct from new.owner_user_id or a.group_id is distinct from new.group_id then
    raise exception 'a goal must name an account of its own scope' using errcode = 'check_violation';
  end if;
  return new;
end;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION private.assert_goal_contribution_scope()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  g finances.savings_goals;
  t finances.transactions;
begin
  -- A virtual contribution earmarks no movement, so it has no scope to match (RF-77).
  if new.transaction_id is null then
    return new;
  end if;
  select * into g from finances.savings_goals where id = new.goal_id;
  select * into t from finances.transactions where id = new.transaction_id;
  -- A contribution earmarks a movement that shares the goal's scope (RF-77).
  if g.owner_user_id is distinct from t.owner_user_id or g.group_id is distinct from t.group_id then
    raise exception 'a contribution must share its goal''s scope' using errcode = 'check_violation';
  end if;
  return new;
end;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION private.assert_group_has_leader()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  -- The group is gone again by commit, which is legal.
  if not exists (select 1 from finances.groups g where g.id = new.id) then return null; end if;
  if not exists (
    select 1 from finances.group_members m
    where m.group_id = new.id and m.role = 'leader' and m.archived_at is null
  ) then
    raise exception 'group % was created without a leader', new.id using errcode = 'check_violation';
  end if;
  return null;
end;
$function$;
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
  ) then
    raise exception 'group % would be left without a leader', old.group_id using errcode = 'check_violation';
  end if;
  return null;
end;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION private.assert_installment_allocation()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  covers bigint;
  allocated bigint;
begin
  if new.paid_transaction_id is null then return null; end if;
  select t.amount_cents into covers from finances.transactions t where t.id = new.paid_transaction_id;
  -- The movement was deleted in the same transaction; the foreign key already cleared the link.
  if not found then return null; end if;
  select coalesce(sum(l.amount_cents), 0) into allocated
    from finances.installment_lines l where l.paid_transaction_id = new.paid_transaction_id;
  if allocated > covers then
    raise exception 'a movement of % cannot pay lines totalling %', covers, allocated using errcode = 'check_violation';
  end if;
  -- Oldest first, across every plan on the account: nothing this movement pays may be preceded by a
  -- line of the same account still unpaid.
  if exists (
    select 1
    from finances.installment_lines paid
    join finances.installment_plans paid_plan on paid_plan.id = paid.plan_id
    join finances.installment_plans older_plan on older_plan.account_id = paid_plan.account_id
    join finances.installment_lines older on older.plan_id = older_plan.id
    where paid.paid_transaction_id = new.paid_transaction_id
      and older.paid_transaction_id is null
      and (older.due_date, older.seq) < (paid.due_date, paid.seq)
  ) then
    raise exception 'an older unpaid line of the same account comes first' using errcode = 'check_violation';
  end if;
  return null;
end;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION private.assert_installment_line_payment()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  p finances.installment_plans;
  t finances.transactions;
begin
  -- Only a linked settlement is guarded; the allocator lives in the app layer (RF-82).
  if new.paid_transaction_id is null then return new; end if;
  select * into p from finances.installment_plans where id = new.plan_id;
  select * into t from finances.transactions where id = new.paid_transaction_id;
  -- The settling movement must touch the plan's own account.
  if t.from_account_id is distinct from p.account_id and t.to_account_id is distinct from p.account_id then
    raise exception 'a settling movement must touch the plan account' using errcode = '23514';
  end if;
  return new;
end;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION private.assert_installment_plan_account()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  a finances.accounts;
begin
  select * into a from finances.accounts where id = new.account_id;
  -- A plan schedules a liability's balance; it never attaches to an asset (RF-81).
  if a.kind <> 'liability' then
    raise exception 'an installment plan attaches to a liability account' using errcode = '23514';
  end if;
  return new;
end;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION private.assert_label_matches_transaction()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  t finances.transactions;
  l finances.labels;
begin
  select * into t from finances.transactions where id = new.transaction_id;
  select * into l from finances.labels where id = new.label_id;
  if l.owner_user_id is distinct from t.owner_user_id or l.group_id is distinct from t.group_id then
    raise exception 'a label must share the movement''s scope' using errcode = 'check_violation';
  end if;
  return new;
end;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION private.assert_member_without_history()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  -- A row no one ever claimed carries no user to have acted as.
  if old.user_id is null then return old; end if;
  -- The group itself is gone: the cascade took its roster with it, which is legal.
  if not exists (select 1 from finances.groups g where g.id = old.group_id) then return old; end if;
  if exists (
    select 1 from finances.transactions t
    where t.created_by = old.user_id or t.owner_user_id = old.user_id
  ) or exists (
    select 1 from finances.accounts a where a.owner_user_id = old.user_id
  ) then
    raise exception 'member % has history and can only be archived', old.id using errcode = 'check_violation';
  end if;
  return old;
end;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION private.assert_split_matches_transaction()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  t finances.transactions;
  c finances.categories;
begin
  select * into t from finances.transactions where id = new.transaction_id;
  select * into c from finances.categories where id = new.category_id;
  -- A transfer moves money between accounts; it names no category (RF-69).
  if t.kind = 'transfer' then
    raise exception 'a transfer takes no split' using errcode = 'check_violation';
  end if;
  if c.owner_user_id is distinct from t.owner_user_id or c.group_id is distinct from t.group_id then
    raise exception 'a split category must share the movement''s scope' using errcode = 'check_violation';
  end if;
  if c.kind <> t.kind then
    raise exception 'a split category must share the movement''s kind' using errcode = 'check_violation';
  end if;
  return new;
end;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION private.assert_transaction_currency()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_from text;
  v_to text;
  v_foreign boolean;
begin
  select a.settlement_currency into v_from from finances.accounts a where a.id = new.from_account_id;
  select a.settlement_currency into v_to from finances.accounts a where a.id = new.to_account_id;
  if v_from is not null and v_to is not null and v_from is distinct from v_to
     and new.currency not in (v_from, v_to) then
    raise exception 'a transfer between two currencies is booked in one of them' using errcode = '23901';
  end if;
  v_foreign := (v_from is not null and v_from <> new.currency) or (v_to is not null and v_to <> new.currency);
  if v_foreign and new.counter_amount_cents is null then
    raise exception 'a movement in another currency carries its amount in the account''s own' using errcode = '23901';
  end if;
  if not v_foreign and new.counter_amount_cents is not null then
    raise exception 'a movement in the account''s own currency carries no second amount' using errcode = '23901';
  end if;
  if new.counter_is_estimate and num_nonnulls(new.from_account_id, new.to_account_id) = 2 then
    raise exception 'only a one-sided movement carries an estimate' using errcode = '23901';
  end if;
  return new;
end;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION private.assert_transaction_splits_sum()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_txn_id uuid;
  t finances.transactions;
  v_sum bigint;
  v_count bigint;
begin
  if tg_table_name = 'transactions' then
    v_txn_id := new.id;
  else
    v_txn_id := coalesce(new.transaction_id, old.transaction_id);
  end if;
  -- The parent may have gone with a cascade delete: nothing left to reconcile.
  select * into t from finances.transactions where id = v_txn_id;
  if not found then return null; end if;
  select coalesce(sum(amount_cents), 0), count(*) into v_sum, v_count
    from finances.transaction_splits where transaction_id = v_txn_id;
  if t.kind = 'transfer' then
    if v_count > 0 then
      raise exception 'a transfer carries no split' using errcode = 'check_violation';
    end if;
  else
    if v_count = 0 then
      raise exception 'an income or expense needs at least one split' using errcode = 'check_violation';
    end if;
    if v_sum <> t.amount_cents then
      raise exception 'the splits must sum to the movement amount' using errcode = 'check_violation';
    end if;
  end if;
  return null;
end;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION private.can_read_account(uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  -- Mirrors the accounts SELECT predicate, for the debt rows that hang off an account.
  select exists (
    select 1 from finances.accounts a
    where a.id = $1 and (
      a.owner_user_id = (select auth.uid())
      or private.is_group_member(coalesce(a.group_id, private.owner_group_id(a.owner_user_id)))
    )
  );
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION private.can_read_transaction(uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  -- Mirrors the transactions SELECT predicate, for the splits and labels that hang off a movement.
  select exists (
    select 1 from finances.transactions t
    where t.id = $1 and (
      t.owner_user_id = (select auth.uid())
      or private.is_group_member(coalesce(t.group_id, private.owner_group_id(t.owner_user_id)))
    )
  );
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION private.can_write_account(account_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  -- The owner writes their own account; any group member writes one the owner marked shared.
  select exists (
    select 1 from finances.accounts a
    where a.id = $1 and (
      a.owner_user_id = (select auth.uid())
      or (a.is_shared and private.is_group_member(a.group_id))
    )
  );
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION private.can_write_transaction_row(uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  -- The writability of a split or label reduces to the writability of its parent movement's accounts.
  select private.can_write_transaction(t.from_account_id, t.to_account_id)
  from finances.transactions t where t.id = $1;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION private.capture_audit()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_survivor jsonb;
  v_before jsonb;
  v_after jsonb;
  v_record_id text;
begin
  if tg_op = 'DELETE' then
    v_survivor := to_jsonb(old);
    v_before := to_jsonb(old);
    v_after := null;
  elsif tg_op = 'INSERT' then
    v_survivor := to_jsonb(new);
    v_before := null;
    v_after := to_jsonb(new);
  else
    v_survivor := to_jsonb(new);
    v_before := to_jsonb(old);
    v_after := to_jsonb(new);
  end if;

  if tg_table_name = 'transaction_labels' then
    v_record_id := (v_survivor->>'transaction_id') || ':' || (v_survivor->>'label_id');
  elsif tg_table_name = 'debt_terms' then
    v_record_id := v_survivor->>'account_id';
  else
    v_record_id := v_survivor->>'id';
  end if;

  insert into finances.audit_log
    (entity, record_id, action, actor_user_id, owner_user_id, group_id, before_data, after_data, occurred_at)
  values
    (tg_table_name, v_record_id, tg_op, (select auth.uid()),
     (v_survivor->>'owner_user_id')::uuid, (v_survivor->>'group_id')::uuid,
     v_before, v_after, now());
  return null;
end;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION private.claim_group_invite()
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_user uuid := auth.uid();
  v_email text := auth.email();
  v_id uuid;
begin
  if v_user is null or v_email is null then return null; end if;
  select m.id into v_id from finances.group_members m
    where m.user_id is null
      and m.invite_email is not null
      and m.archived_at is null
      and pg_catalog.lower(m.invite_email) = pg_catalog.lower(v_email)
    order by m.created_at, m.id
    limit 1
    for update;
  if v_id is null then return null; end if;
  update finances.group_members m
    set user_id = v_user, invite_email = null
    where m.id = v_id;
  return v_id;
end;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION private.group_is_unclaimed(uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select not exists (select 1 from finances.group_members m where m.group_id = $1);
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION private.hand_account_to_group(p_account uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_user uuid := (select auth.uid());
  v_group uuid;
  v_account finances.accounts;
begin
  select m.group_id into v_group from finances.group_members m
    where m.user_id = v_user and m.archived_at is null;
  if not found then
    raise exception 'the caller belongs to no group' using errcode = 'check_violation';
  end if;
  select * into v_account from finances.accounts a
    where a.id = p_account and a.owner_user_id = v_user
    for update;
  if v_account.id is null then
    if exists (select 1 from finances.accounts a where a.id = p_account and a.group_id = v_group) then
      raise exception 'account % already belongs to a group', p_account using errcode = 'check_violation';
    end if;
    raise exception 'account % is not the caller''s', p_account using errcode = 'check_violation';
  end if;
  if v_account.archived_at is not null then
    raise exception 'account % is archived', p_account using errcode = 'check_violation';
  end if;
  if exists (
    select 1 from finances.transactions t
    where t.from_account_id = p_account or t.to_account_id = p_account
  ) or exists (
    select 1 from finances.planned_payments p
    where p.from_account_id = p_account or p.to_account_id = p_account
  ) or exists (
    select 1 from finances.recurring_rules r
    where r.from_account_id = p_account or r.to_account_id = p_account
  ) or exists (
    select 1 from finances.budgets b where b.account_id = p_account
  ) or exists (
    select 1 from finances.savings_goals g where g.account_id = p_account
  ) or exists (
    select 1 from finances.installment_plans i where i.account_id = p_account
  ) or exists (
    select 1 from finances.account_statements s where s.account_id = p_account
  ) or exists (
    select 1 from finances.ingest_deliveries d where d.proposed_account_id = p_account
  ) or exists (
    select 1 from finances.webhook_credentials w where w.default_account_id = p_account
  ) then
    raise exception 'account % carries history and is archived, not handed over', p_account using errcode = 'check_violation';
  end if;
  update finances.accounts
    set owner_user_id = null, group_id = v_group, is_shared = true
    where id = p_account;
  return true;
end;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION private.is_group_leader(uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select exists (
    select 1 from finances.group_members m
    where m.group_id = $1 and m.user_id = (select auth.uid()) and m.role = 'leader' and m.archived_at is null
  );
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION private.is_group_member(uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select exists (
    select 1 from finances.group_members m
    where m.group_id = $1 and m.user_id = (select auth.uid()) and m.archived_at is null
  );
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION private.owner_group_id(p_owner uuid)
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select group_id from finances.group_members where user_id = p_owner and archived_at is null limit 1
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION private.purge_audit_log()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  delete from finances.audit_log where occurred_at < now() - interval '24 months';
end;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION private.remember_counterparty(p_key text, p_label text, p_side text, p_account_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_owner uuid := (select auth.uid());
  v_row finances.ingest_counterparties;
begin
  if v_owner is null then
    raise exception 'remember_counterparty requires an authenticated session';
  end if;

  select * into v_row from finances.ingest_counterparties c
    where c.owner_user_id = v_owner and c.pattern_key = p_key and c.side = p_side
    for update;

  if not found then
    insert into finances.ingest_counterparties
      (owner_user_id, pattern_key, pattern_label, side, state, candidate_account_id, streak)
    values (v_owner, p_key, p_label, p_side, 'learning', p_account_id, 1);
    return;
  end if;

  -- Ambiguity is sticky: no later agreement undoes it, only the person forgetting the pattern.
  if v_row.state = 'ambiguous' then return; end if;

  if v_row.state = 'trusted' then
    if v_row.trusted_account_id = p_account_id then return; end if;
    update finances.ingest_counterparties
      set state = 'ambiguous', trusted_account_id = null,
          candidate_account_id = p_account_id, streak = 0
      where id = v_row.id;
    return;
  end if;

  if v_row.candidate_account_id = p_account_id then
    update finances.ingest_counterparties
      set state = 'trusted', trusted_account_id = p_account_id, streak = 2
      where id = v_row.id;
  else
    -- The run broke, so the new account starts its own; nothing is pinned on one completion.
    update finances.ingest_counterparties
      set candidate_account_id = p_account_id, streak = 1
      where id = v_row.id;
  end if;
end;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION private.remember_ingest_merchant(p_key text, p_label text, p_category_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_owner uuid := (select auth.uid());
  v_row finances.ingest_merchants;
begin
  if v_owner is null then
    raise exception 'remember_ingest_merchant requires an authenticated session';
  end if;

  select * into v_row from finances.ingest_merchants m
    where m.owner_user_id = v_owner and m.merchant_key = p_key
    for update;

  if not found then
    insert into finances.ingest_merchants
      (owner_user_id, merchant_key, merchant_label, state, candidate_category_id, streak)
    values (v_owner, p_key, p_label, 'learning', p_category_id, 1);
    return;
  end if;

  -- Ambiguity is sticky: no later consistency undoes it, only the person forgetting the merchant.
  if v_row.state = 'ambiguous' then return; end if;

  if v_row.state = 'trusted' then
    if v_row.trusted_category_id = p_category_id then return; end if;
    update finances.ingest_merchants
      set state = 'ambiguous', trusted_category_id = null,
          candidate_category_id = p_category_id, streak = 0
      where id = v_row.id;
    return;
  end if;

  if v_row.candidate_category_id = p_category_id then
    update finances.ingest_merchants
      set state = 'trusted', trusted_category_id = p_category_id, streak = 2
      where id = v_row.id;
  else
    -- The run broke, so the new category starts its own; nothing is pinned on one approval.
    update finances.ingest_merchants
      set candidate_category_id = p_category_id, streak = 1
      where id = v_row.id;
  end if;
end;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION private.resolve_webhook_credential(p_token_hash text)
 RETURNS TABLE(id uuid, owner_user_id uuid, default_account_id uuid, default_category_id uuid, throttled boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_cred finances.webhook_credentials;
  v_reset boolean;
  v_throttled boolean;
begin
  select * into v_cred from finances.webhook_credentials c
    where c.token_hash = p_token_hash and c.revoked_at is null
    for update;
  if not found then return; end if;
  v_reset := v_cred.rate_window_started_at is null
             or (pg_catalog.now() - v_cred.rate_window_started_at) >= interval '1 minute';
  if v_reset then
    v_throttled := false;
    update finances.webhook_credentials c set last_used_at = pg_catalog.now(),
      rate_window_started_at = pg_catalog.now(), rate_count = 1 where c.id = v_cred.id;
  elsif v_cred.rate_count < v_cred.rate_limit_per_min then
    -- The request that reaches exactly the limit is still admitted.
    v_throttled := false;
    update finances.webhook_credentials c set last_used_at = pg_catalog.now(),
      rate_count = v_cred.rate_count + 1 where c.id = v_cred.id;
  else
    -- Over the limit: a valid token, but do not count it and do not admit it.
    v_throttled := true;
    update finances.webhook_credentials c set last_used_at = pg_catalog.now() where c.id = v_cred.id;
  end if;
  return query select v_cred.id, v_cred.owner_user_id, v_cred.default_account_id,
    v_cred.default_category_id, v_throttled;
end;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION private.run_due_recurring_rules(p_created_by uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  r finances.recurring_rules;
  v_today date := (now() at time zone 'America/Bogota')::date;
  v_next date;
  v_active boolean;
  v_txn_id uuid;
  v_month_first date;
  v_days_in_month int;
  v_year int;
  v_month int;
begin
  for r in
    select * from finances.recurring_rules
    where is_active and next_run_on <= v_today
      and (p_created_by is null or created_by = p_created_by)
  loop
    v_next := r.next_run_on;
    v_active := true;
    -- Back-fill every period the rule missed, each dated its own real past day.
    while v_next <= v_today loop
      -- The rule holds its single account on the matching side, so from/to copy straight over and the
      -- generated `kind` follows; the scope, author and rule link are the rule's own.
      insert into finances.transactions
        (owner_user_id, group_id, from_account_id, to_account_id, amount_cents,
         occurred_at, description, recurring_rule_id, reviewed_at, created_by)
      values
        (r.owner_user_id, r.group_id, r.from_account_id, r.to_account_id, r.amount_cents,
         v_next, r.description, r.id, null, r.created_by)
      returning id into v_txn_id;
      -- Every rule is one-sided income or expense, so it always lands exactly one split.
      insert into finances.transaction_splits (transaction_id, category_id, amount_cents)
        values (v_txn_id, r.category_id, r.amount_cents);
      -- Advance off the anchor, never off a clamped date: a day-31 rule yields Feb 28/29 then Mar 31.
      if r.frequency = 'weekly' then
        v_next := v_next + (7 * r.interval_n);
      elsif r.frequency = 'monthly' then
        v_month_first := (date_trunc('month', v_next::timestamp)
          + make_interval(months => r.interval_n))::date;
        v_days_in_month := extract(day from
          (v_month_first + interval '1 month' - interval '1 day'))::int;
        v_next := v_month_first + (least(r.day_of_month, v_days_in_month) - 1);
      else
        v_year := extract(year from v_next)::int + r.interval_n;
        v_month := extract(month from v_next)::int;
        v_days_in_month := extract(day from
          (make_date(v_year, v_month, 1) + interval '1 month' - interval '1 day'))::int;
        v_next := make_date(v_year, v_month, least(r.day_of_month, v_days_in_month));
      end if;
      -- Once the advanced date clears the end, the rule has run its course.
      if r.ends_on is not null and v_next > r.ends_on then
        v_active := false;
        exit;
      end if;
    end loop;
    update finances.recurring_rules
      set next_run_on = v_next, is_active = v_active
      where id = r.id;
  end loop;
end;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION private.set_ingest_delivery_state()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_decision text;
begin
  new.owner_user_id := (select auth.uid());
  select s.decision into v_decision from finances.ingest_shapes s
    where s.owner_user_id = new.owner_user_id and s.shape_hash = new.shape_hash;
  if v_decision = 'rejected' then
    new.status := 'rejected';
    new.resolved_at := pg_catalog.now();
    new.silenced_on_arrival := true;
  else
    new.status := 'pending';
    new.resolved_at := null;
    new.silenced_on_arrival := false;
  end if;
  return new;
end;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION private.set_planned_payment_scope()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_from_group uuid;
  v_to_group uuid;
begin
  select a.group_id into v_from_group from finances.accounts a where a.id = new.from_account_id;
  select a.group_id into v_to_group from finances.accounts a where a.id = new.to_account_id;
  if coalesce(v_from_group, v_to_group) is not null then
    new.group_id := coalesce(v_from_group, v_to_group);
    new.owner_user_id := null;
  else
    new.owner_user_id := (select auth.uid());
    new.group_id := null;
  end if;
  if tg_op = 'INSERT' then
    new.created_by := (select auth.uid());
  else
    -- A caller granted UPDATE still cannot rewrite who first planned the payment.
    new.created_by := old.created_by;
  end if;
  return new;
end;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION private.set_recurring_rule_scope()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_from_group uuid;
  v_to_group uuid;
begin
  if (select auth.uid()) is null then
    return new;
  end if;
  select a.group_id into v_from_group from finances.accounts a where a.id = new.from_account_id;
  select a.group_id into v_to_group from finances.accounts a where a.id = new.to_account_id;
  if coalesce(v_from_group, v_to_group) is not null then
    new.group_id := coalesce(v_from_group, v_to_group);
    new.owner_user_id := null;
  else
    new.owner_user_id := (select auth.uid());
    new.group_id := null;
  end if;
  if tg_op = 'INSERT' then
    new.created_by := (select auth.uid());
  else
    -- A caller granted UPDATE still cannot rewrite who first recorded the rule.
    new.created_by := old.created_by;
  end if;
  return new;
end;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION private.set_transaction_currency()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_from text;
  v_to text;
begin
  if new.currency is not null then
    return new;
  end if;
  select a.settlement_currency into v_from from finances.accounts a where a.id = new.from_account_id;
  select a.settlement_currency into v_to from finances.accounts a where a.id = new.to_account_id;
  new.currency := coalesce(v_from, v_to);
  return new;
end;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION private.set_transaction_scope()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_from_group uuid;
  v_to_group uuid;
begin
  if (select auth.uid()) is null then
    return new;
  end if;
  select a.group_id into v_from_group from finances.accounts a where a.id = new.from_account_id;
  select a.group_id into v_to_group from finances.accounts a where a.id = new.to_account_id;
  if coalesce(v_from_group, v_to_group) is not null then
    new.group_id := coalesce(v_from_group, v_to_group);
    new.owner_user_id := null;
  else
    new.owner_user_id := (select auth.uid());
    new.group_id := null;
  end if;
  if tg_op = 'INSERT' then
    new.created_by := (select auth.uid());
  else
    -- A caller granted UPDATE still cannot rewrite who first recorded the movement.
    new.created_by := old.created_by;
  end if;
  return new;
end;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION private.transfer_group_leadership(p_member uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_self finances.group_members;
  v_target finances.group_members;
begin
  select * into v_self from finances.group_members m
    where m.user_id = (select auth.uid()) and m.archived_at is null
    for update;
  if not found then
    raise exception 'the caller belongs to no group' using errcode = 'check_violation';
  end if;
  if v_self.role <> 'leader' then
    raise exception 'only the leader transfers the role' using errcode = 'check_violation';
  end if;
  select * into v_target from finances.group_members m
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
  update finances.group_members set role = 'leader' where id = v_target.id;
  update finances.group_members set role = 'member' where id = v_self.id;
  return true;
end;
$function$;
