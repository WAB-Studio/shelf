-- RF-161: deleting the movement that settled a planned payment returns the payment to pending, unlinked. The FK's
-- `on delete set null` runs an UPDATE on planned_payments inside the deleting statement, so this guard sees that UPDATE
-- after the movement is already gone, whichever trigger fires first. A writer cannot forge it: while the movement
-- exists, the link stays refused; once it is gone, the FK has already cleared the link. Every other line is 0002's.
CREATE OR REPLACE FUNCTION private.guard_planned_payment_settle() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
begin
  -- The link was cleared because its movement no longer exists: only the FK's set-null reaches this.
  if old.settled_transaction_id is not null
     and new.settled_transaction_id is null
     and not exists (select 1 from finances.transactions t where t.id = old.settled_transaction_id) then
    -- A cancelled payment keeps its status; only a settled one goes back to be paid again.
    if old.status = 'done' then
      new.status := 'pending';
    end if;
    return new;
  end if;
  -- While a payment points at an existing movement, that link is permanent.
  if old.settled_transaction_id is not null
     and new.settled_transaction_id is distinct from old.settled_transaction_id then
    raise exception 'a settled payment cannot change its transaction' using errcode = 'check_violation';
  end if;
  -- 'done' and 'cancelled' are terminal by hand: a payment returns to pending only through the branch above.
  if old.status in ('done', 'cancelled') and new.status = 'pending' then
    raise exception 'a settled or cancelled payment cannot return to pending' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION private.guard_planned_payment_settle() FROM public, anon, authenticated, service_role;
