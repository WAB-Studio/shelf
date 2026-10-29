-- D10: the generator swept every user's due rules unconditionally, so a fixture or a seed running
-- with no JWT — the same way the daily cron runs — could land movements on a rule that is not its
-- caller's. A nullable parameter keeps the one loop and the one back-fill body: called with no
-- argument, exactly the cron's own text (`select private.run_due_recurring_rules()`), the default
-- resolves to null and every due rule runs, unchanged from 0007; named a user, only the rules that
-- user created run. The alternative set aside was a second function: it would either duplicate this
-- loop's whole body — the shape 0013 had to repair once already for a shadowed OUT column — or
-- reduce the original to a wrapper calling the new one, which is the same behaviour with one more
-- name to grant, revoke and keep in step for no gain over a default argument.
--
-- The scope is `created_by`, not `owner_user_id`: a group rule carries no owner, only a group, so
-- `owner_user_id` would silently drop every rule a user created for a shared account. `created_by`
-- is `not null` on every row and names the one caller a fixture or a seed writes as.
drop function private.run_due_recurring_rules();--> statement-breakpoint
create function private.run_due_recurring_rules(p_created_by uuid default null) returns void
language plpgsql security definer set search_path = '' as $$
declare
  r public.recurring_rules;
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
    select * from public.recurring_rules
    where is_active and next_run_on <= v_today
      and (p_created_by is null or created_by = p_created_by)
  loop
    v_next := r.next_run_on;
    v_active := true;
    -- Back-fill every period the rule missed, each dated its own real past day.
    while v_next <= v_today loop
      -- The rule holds its single account on the matching side, so from/to copy straight over and the
      -- generated `kind` follows; the scope, author and rule link are the rule's own.
      insert into public.transactions
        (owner_user_id, group_id, from_account_id, to_account_id, amount_cents,
         occurred_at, description, recurring_rule_id, reviewed_at, created_by)
      values
        (r.owner_user_id, r.group_id, r.from_account_id, r.to_account_id, r.amount_cents,
         v_next, r.description, r.id, null, r.created_by)
      returning id into v_txn_id;
      -- Every rule is one-sided income or expense, so it always lands exactly one split.
      insert into public.transaction_splits (transaction_id, category_id, amount_cents)
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
    update public.recurring_rules
      set next_run_on = v_next, is_active = v_active
      where id = r.id;
  end loop;
end;
$$;--> statement-breakpoint
revoke all on function private.run_due_recurring_rules(uuid) from public, anon, authenticated, service_role;
