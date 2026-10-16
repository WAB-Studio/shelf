-- `num_nonnulls(from_account_id, to_account_id) >= 1` counts the accounts and never compares them, so
-- a movement naming one account on both sides committed, took `kind = 'transfer'` from the generated
-- column and entered the ledger as a real entry netting zero — proved on the live database as one row
-- returned. RF-101 refuses the pair. `is distinct from` leaves a one-sided movement legal: one side is
-- null, so the pair still differs. No live row violates either check — 0 in `transactions`, 0 in
-- `planned_payments` at the time of writing.
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_accounts_distinct" CHECK ("transactions"."from_account_id" is distinct from "transactions"."to_account_id");--> statement-breakpoint
ALTER TABLE "planned_payments" ADD CONSTRAINT "planned_payments_accounts_distinct" CHECK ("planned_payments"."from_account_id" is distinct from "planned_payments"."to_account_id");--> statement-breakpoint
-- The composite foreign key on `(parent_id, group_id)` is MATCH SIMPLE, so it is not evaluated at all
-- when `group_id` is null — which is every personal category. `assert_category_depth` checked
-- self-reference, depth and kind and never scope, so a personal category named a group category,
-- another person's category, or a uuid that exists in no row; the picker query then dropped it in
-- silence. RF-63 already says a subcategory shares its parent's scope. Both refusals proved on the
-- live database as one row landed each. No live row violates either — 0 cross-scope, 0 orphaned.
create or replace function private.assert_category_depth() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  parent public.categories;
begin
  if new.parent_id is null then return new; end if;
  if new.parent_id = new.id then
    raise exception 'a category cannot be its own parent' using errcode = 'check_violation';
  end if;
  if exists (select 1 from public.categories c where c.parent_id = new.id) then
    raise exception 'category % already has children and cannot become one', new.id using errcode = 'check_violation';
  end if;
  select * into parent from public.categories c where c.id = new.parent_id;
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
$$;--> statement-breakpoint
-- `groups_insert_any` is `WITH CHECK true` and `assert_group_keeps_leader` fires only on UPDATE and
-- DELETE, so an insert into `groups` not followed by its leader row committed an orphan: it fails its
-- own SELECT policy, `groups` has no DELETE policy and no DELETE grant, and nobody can ever remove it.
-- Proved on the live database as `INSERT 1` whose own `select` saw zero rows and whose `delete` was
-- refused. Deferred, so `createGroup` may write the group and its leader in either order inside its
-- one transaction. No live group is leaderless — 0 at the time of writing.
create or replace function private.assert_group_has_leader() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  -- The group is gone again by commit, which is legal.
  if not exists (select 1 from public.groups g where g.id = new.id) then return null; end if;
  if not exists (
    select 1 from public.group_members m
    where m.group_id = new.id and m.role = 'leader' and m.archived_at is null
  ) then
    raise exception 'group % was created without a leader', new.id using errcode = 'check_violation';
  end if;
  return null;
end;
$$;--> statement-breakpoint
revoke all on function private.assert_group_has_leader() from public, anon, authenticated, service_role;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "assert_group_has_leader"
  AFTER INSERT ON "groups"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION private.assert_group_has_leader();--> statement-breakpoint
-- "Paid in full or not at all, oldest first" (RF-82) lived only in a TypeScript loop:
-- `assert_installment_line_payment` checked nothing but that the movement touches the plan's account,
-- and `paid_transaction_id` is the one column `authenticated` may UPDATE on `installment_lines`. One
-- 100-cent movement marked all three 100000-cent lines of a plan paid on the live database, and the
-- derived pending read 0 against an untouched debt. It is money, so the rule descends to the engine.
-- Deferred, so the allocator's multi-row UPDATE is judged once the whole allocation is in place.
create or replace function private.assert_installment_allocation() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  covers bigint;
  allocated bigint;
begin
  if new.paid_transaction_id is null then return null; end if;
  select t.amount_cents into covers from public.transactions t where t.id = new.paid_transaction_id;
  -- The movement was deleted in the same transaction; the foreign key already cleared the link.
  if not found then return null; end if;
  select coalesce(sum(l.amount_cents), 0) into allocated
    from public.installment_lines l where l.paid_transaction_id = new.paid_transaction_id;
  if allocated > covers then
    raise exception 'a movement of % cannot pay lines totalling %', covers, allocated using errcode = 'check_violation';
  end if;
  -- Oldest first, across every plan on the account: nothing this movement pays may be preceded by a
  -- line of the same account still unpaid.
  if exists (
    select 1
    from public.installment_lines paid
    join public.installment_plans paid_plan on paid_plan.id = paid.plan_id
    join public.installment_plans older_plan on older_plan.account_id = paid_plan.account_id
    join public.installment_lines older on older.plan_id = older_plan.id
    where paid.paid_transaction_id = new.paid_transaction_id
      and older.paid_transaction_id is null
      and (older.due_date, older.seq) < (paid.due_date, paid.seq)
  ) then
    raise exception 'an older unpaid line of the same account comes first' using errcode = 'check_violation';
  end if;
  return null;
end;
$$;--> statement-breakpoint
revoke all on function private.assert_installment_allocation() from public, anon, authenticated, service_role;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "assert_installment_allocation"
  AFTER INSERT OR UPDATE OF "paid_transaction_id" ON "installment_lines"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION private.assert_installment_allocation();
