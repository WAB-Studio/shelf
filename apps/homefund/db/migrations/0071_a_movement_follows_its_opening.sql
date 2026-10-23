-- RF-162: a movement is never dated before the opening day of an account it names, and an opening never moves past a
-- movement it already has. Rows stored before their opening stay as they are: neither trigger reads them unless the
-- write itself moves the day, an account or the opening across them.
CREATE OR REPLACE FUNCTION private.assert_movement_after_opening()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  -- The form names every column; an edit that leaves the day and both accounts alone keeps an old row as it was.
  if tg_op = 'UPDATE' and new.occurred_at = old.occurred_at
     and new.from_account_id is not distinct from old.from_account_id
     and new.to_account_id is not distinct from old.to_account_id then
    return new;
  end if;
  -- An account the caller cannot write is left to the policy, so no refusal below tells a stranger its opening day.
  -- The import and the nightly run write as the owner with no claim, and are held to the rule.
  if (select auth.uid()) is not null
     and not private.can_write_transaction(new.from_account_id, new.to_account_id) then
    return new;
  end if;
  if exists (
    select 1 from finances.accounts a
    where a.id in (new.from_account_id, new.to_account_id) and new.occurred_at < a.initial_balance_on
  ) then
    raise exception 'a movement cannot predate the opening of an account it names' using errcode = 'MO001';
  end if;
  return new;
end;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION private.assert_movement_after_opening() FROM public, anon, authenticated, service_role;
--> statement-breakpoint
CREATE TRIGGER transactions_after_opening BEFORE INSERT OR UPDATE OF occurred_at, from_account_id, to_account_id
  ON finances.transactions FOR EACH ROW EXECUTE FUNCTION private.assert_movement_after_opening();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION private.assert_opening_before_movements()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  -- Only the days the opening newly passes are read: moved earlier or re-sent, it leaves older rows alone.
  if new.initial_balance_on <= old.initial_balance_on then
    return new;
  end if;
  -- One exists per leg, so each reads its own account index.
  if exists (select 1 from finances.transactions t
             where t.from_account_id = old.id
               and t.occurred_at >= old.initial_balance_on and t.occurred_at < new.initial_balance_on)
     or exists (select 1 from finances.transactions t
                where t.to_account_id = old.id
                  and t.occurred_at >= old.initial_balance_on and t.occurred_at < new.initial_balance_on) then
    raise exception 'an account''s opening cannot move past one of its movements' using errcode = 'MO002';
  end if;
  return new;
end;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION private.assert_opening_before_movements() FROM public, anon, authenticated, service_role;
--> statement-breakpoint
CREATE TRIGGER accounts_opening_before_movements BEFORE UPDATE OF initial_balance_on
  ON finances.accounts FOR EACH ROW EXECUTE FUNCTION private.assert_opening_before_movements();
