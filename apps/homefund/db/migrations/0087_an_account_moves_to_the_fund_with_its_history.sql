-- RF-180: a person's own account moves into their fund with everything it holds: id, movements, balance, pockets, statements, debt terms.
-- Hand-written: drizzle-kit diffs no function. Replaces 0047's `hand_account_to_group`, which refused any history.
-- What the move re-derives: a movement, a planned payment or a rule touching the account takes the fund's scope (their own
-- triggers read the accounts), so every one of them is touched once. What it cannot carry is a personal category or label
-- the fund has no twin for (same kind, name and parent name): MV001 / MV002. A personal budget or goal pointing at the account
-- or at one of its movements stays personal, so it is MV003. A pocket moves with its parent, never alone: MV004.
-- An income already in the account keeps no «De quién» (RF-167: nothing is presumed). Audit (RF-45) captures every update
-- through the table triggers, under the caller.
CREATE OR REPLACE FUNCTION private.fund_twin_category(p_category uuid, p_group uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  select g.id
  from finances.categories c
  join finances.categories g on g.group_id = p_group and g.kind = c.kind and lower(btrim(g.name)) = lower(btrim(c.name))
  left join finances.categories cp on cp.id = c.parent_id
  left join finances.categories gp on gp.id = g.parent_id
  where c.id = p_category and lower(btrim(coalesce(gp.name, ''))) = lower(btrim(coalesce(cp.name, '')))
  order by g.created_at, g.id
  limit 1
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION private.fund_twin_label(p_label uuid, p_group uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  select g.id
  from finances.labels l
  join finances.labels g on g.group_id = p_group and lower(btrim(g.name)) = lower(btrim(l.name))
  where l.id = p_label
  order by g.created_at, g.id
  limit 1
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION private.fund_twin_category(uuid, uuid), private.fund_twin_label(uuid, uuid) FROM public, anon, authenticated, service_role;--> statement-breakpoint
CREATE OR REPLACE FUNCTION private.hand_account_to_group(p_account uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
declare
  v_user uuid := (select auth.uid());
  v_group uuid;
  v_account finances.accounts;
  v_ids uuid[];
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
  if v_account.parent_account_id is not null then
    raise exception 'account % is a pocket and moves with its parent', p_account using errcode = 'MV004';
  end if;

  select array_agg(a.id) into v_ids from finances.accounts a where a.id = p_account or a.parent_account_id = p_account;

  if exists (select 1 from finances.budgets b where b.account_id = any (v_ids))
     or exists (select 1 from finances.savings_goals g where g.account_id = any (v_ids))
     or exists (
       select 1 from finances.goal_contributions gc join finances.transactions t on t.id = gc.transaction_id
       where t.from_account_id = any (v_ids) or t.to_account_id = any (v_ids)
     ) then
    raise exception 'a personal budget or goal points at account % or its movements', p_account using errcode = 'MV003';
  end if;

  if exists (
    select 1 from finances.categories c
    where c.owner_user_id is not null and private.fund_twin_category(c.id, v_group) is null and c.id in (
      select s.category_id from finances.transaction_splits s join finances.transactions t on t.id = s.transaction_id
        where t.from_account_id = any (v_ids) or t.to_account_id = any (v_ids)
      union select r.category_id from finances.recurring_rules r where r.from_account_id = any (v_ids) or r.to_account_id = any (v_ids)
      union select p.category_id from finances.planned_payments p where p.from_account_id = any (v_ids) or p.to_account_id = any (v_ids)
    )
  ) then
    raise exception 'personal categories of account % have no twin in the fund', p_account using errcode = 'MV001';
  end if;
  if exists (
    select 1 from finances.labels l
    where l.owner_user_id is not null and private.fund_twin_label(l.id, v_group) is null and l.id in (
      select tl.label_id from finances.transaction_labels tl join finances.transactions t on t.id = tl.transaction_id
        where t.from_account_id = any (v_ids) or t.to_account_id = any (v_ids)
    )
  ) then
    raise exception 'personal labels of account % have no twin in the fund', p_account using errcode = 'MV002';
  end if;

  -- A parent with pockets keeps its scope (PK002), so the pockets step out and back in around it.
  update finances.accounts set parent_account_id = null where parent_account_id = p_account;
  update finances.accounts set owner_user_id = null, group_id = v_group, is_shared = true where id = any (v_ids);
  update finances.accounts set parent_account_id = p_account where id = any (v_ids) and id <> p_account and parent_account_id is null;

  -- The scope triggers re-derive from the accounts on any update; the splits follow once their movement has.
  update finances.transactions set description = description where from_account_id = any (v_ids) or to_account_id = any (v_ids);
  update finances.transaction_splits s set category_id = private.fund_twin_category(s.category_id, v_group)
    from finances.transactions t, finances.categories c
    where t.id = s.transaction_id and c.id = s.category_id and c.owner_user_id is not null
      and (t.from_account_id = any (v_ids) or t.to_account_id = any (v_ids));
  update finances.recurring_rules r set category_id = private.fund_twin_category(r.category_id, v_group)
    from finances.categories c
    where c.id = r.category_id and c.owner_user_id is not null and (r.from_account_id = any (v_ids) or r.to_account_id = any (v_ids));
  update finances.planned_payments p set category_id = private.fund_twin_category(p.category_id, v_group)
    from finances.categories c
    where c.id = p.category_id and c.owner_user_id is not null and (p.from_account_id = any (v_ids) or p.to_account_id = any (v_ids));
  delete from finances.transaction_labels tl
    using finances.transactions t, finances.labels l
    where t.id = tl.transaction_id and l.id = tl.label_id and l.owner_user_id is not null
      and (t.from_account_id = any (v_ids) or t.to_account_id = any (v_ids))
      and exists (
        select 1 from finances.transaction_labels o
        where o.transaction_id = tl.transaction_id and o.label_id = private.fund_twin_label(tl.label_id, v_group)
      );
  update finances.transaction_labels tl set label_id = private.fund_twin_label(tl.label_id, v_group)
    from finances.transactions t, finances.labels l
    where t.id = tl.transaction_id and l.id = tl.label_id and l.owner_user_id is not null
      and (t.from_account_id = any (v_ids) or t.to_account_id = any (v_ids));
  update finances.recurring_rules set description = description where from_account_id = any (v_ids) or to_account_id = any (v_ids);
  update finances.planned_payments set description = description where from_account_id = any (v_ids) or to_account_id = any (v_ids);
  return true;
end;
$$;
