ALTER TABLE "finances"."transactions" ADD COLUMN "pocket_cover" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "finances"."transactions" ADD CONSTRAINT "transactions_pocket_cover_shape" CHECK (not "finances"."transactions"."pocket_cover" or (num_nonnulls("finances"."transactions"."from_account_id", "finances"."transactions"."to_account_id") = 2 and "finances"."transactions"."caused_by_transaction_id" is not null));--> statement-breakpoint
-- RF-242: money that leaves a savings account with pockets comes out of its pocket when the account's own (free)
-- part cannot carry it. After a movement from such an account is written, or edited in its amount, accounts,
-- currency or date, the free part is read; if it is below zero the shortfall the movement caused, at most its
-- own amount, moves from the pockets into the account as one transfer per pocket, largest balance first so the
-- fewest pockets are touched, dated the movement's day and caused by it (RF-132), so it goes with it. An edit
-- first takes back what the movement had booked, then reads again. Nothing is booked when the pockets hold less
-- than the shortfall in what they can lend that day; the balance then stays negative, as it was. Definer rights:
-- the movement's own policy already decided who may write the account, and no grant lets a caller name
-- `pocket_cover`. `app.import_history` is a transaction-local switch the spreadsheet import sets, which restores
-- history and never invents a transfer. The account's row lock serialises two writes of one account.
CREATE OR REPLACE FUNCTION private.cover_from_pockets()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_account finances.accounts;
  v_leg bigint;
  v_short bigint;
  v_take bigint;
  v_pocket record;
begin
  if new.pocket_cover or new.reconciliation_id is not null
     or pg_catalog.current_setting('app.import_history', true) = 'on' then
    return null;
  end if;
  if tg_op = 'UPDATE' then
    if new.amount_cents is not distinct from old.amount_cents
       and new.from_account_id is not distinct from old.from_account_id
       and new.to_account_id is not distinct from old.to_account_id
       and new.occurred_at is not distinct from old.occurred_at
       and new.currency is not distinct from old.currency
       and new.counter_amount_cents is not distinct from old.counter_amount_cents
       and new.counter_is_estimate is not distinct from old.counter_is_estimate then
      return null;
    end if;
    delete from finances.transactions where caused_by_transaction_id = new.id and pocket_cover;
  end if;
  if new.from_account_id is null
     or not exists (select 1 from finances.accounts p where p.parent_account_id = new.from_account_id and p.archived_at is null) then
    return null;
  end if;

  select * into v_account from finances.accounts a where a.id = new.from_account_id for no key update;
  -- What leaves the account, in the currency it settles in, as `account_balances` lands the leg: its own amount,
  -- a confirmed second amount when it was spent in another currency, nothing while that is an estimate.
  v_leg := case
    when new.currency = v_account.settlement_currency then new.amount_cents
    when new.counter_amount_cents is not null and not new.counter_is_estimate then new.counter_amount_cents
    else 0
  end;
  if v_leg <= 0 then
    return null;
  end if;
  v_short := least(v_leg, -private.account_settlement_balance_on(v_account.id, 'infinity'::date));
  if v_short <= 0 then
    return null;
  end if;

  for v_pocket in
    select p.id, p.name, b.balance
    from finances.accounts p
    cross join lateral (select private.account_settlement_balance_on(p.id, 'infinity'::date) as balance) b
    where p.parent_account_id = v_account.id
      and p.archived_at is null
      and p.id is distinct from new.to_account_id
      and p.initial_balance_on <= new.occurred_at
      and b.balance > 0
    order by b.balance desc, p.id
  loop
    v_take := least(v_short, v_pocket.balance);
    insert into finances.transactions
      (owner_user_id, group_id, from_account_id, to_account_id, amount_cents, currency,
       occurred_at, description, caused_by_transaction_id, pocket_cover, created_by)
    values
      (v_account.owner_user_id, v_account.group_id, v_pocket.id, v_account.id, v_take,
       v_account.settlement_currency, new.occurred_at,
       'Del bolsillo ' || pg_catalog.left(v_pocket.name, 150) || ' (automático)',
       new.id, true, new.created_by);
    v_short := v_short - v_take;
    exit when v_short = 0;
  end loop;
  return null;
end;
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION private.cover_from_pockets() FROM public, anon, authenticated, service_role;--> statement-breakpoint
CREATE TRIGGER transactions_cover_from_pockets
  AFTER INSERT OR UPDATE OF amount_cents, from_account_id, to_account_id, occurred_at, currency, counter_amount_cents, counter_is_estimate
  ON "finances"."transactions"
  FOR EACH ROW EXECUTE FUNCTION private.cover_from_pockets();
