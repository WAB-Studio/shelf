-- RF-161: the FK's `on delete set null` returns a settled payment through an UPDATE, and this trigger derived the
-- scope on every UPDATE: a personal payment passed to whoever deleted the movement, and with no signed-in user the
-- delete was refused by owner_xor_group. The return now keeps the stored scope. Every other line is 0047's.
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
  -- 0069's guard test: only the FK's set-null clears a link whose movement no longer exists.
  if tg_op = 'UPDATE'
     and old.settled_transaction_id is not null
     and new.settled_transaction_id is null
     and not exists (select 1 from finances.transactions t where t.id = old.settled_transaction_id) then
    new.owner_user_id := old.owner_user_id;
    new.group_id := old.group_id;
    new.created_by := old.created_by;
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
    -- A caller granted UPDATE still cannot rewrite who first planned the payment.
    new.created_by := old.created_by;
  end if;
  return new;
end;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION private.set_planned_payment_scope() FROM public, anon, authenticated, service_role;
