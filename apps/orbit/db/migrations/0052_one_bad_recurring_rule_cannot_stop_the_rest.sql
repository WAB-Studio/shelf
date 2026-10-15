-- H2: the daily cron runs `run_due_recurring_rules()` as one statement over every user's rules, so a
-- single rule whose generated split the split trigger refuses (a category of another scope or kind)
-- raised and rolled back every tenant's movements, every day. Each rule now runs in its own
-- sub-transaction: a rule that raises loses only its own partial back-fill, is paused so the next
-- run does not fail on it again, and the pause lands in the audit log (`capture_audit`). The warning
-- names the rule for the database log.
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
    begin
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
    exception when others then
      raise warning 'recurring rule % skipped and paused: % (%)', r.id, sqlerrm, sqlstate;
      update finances.recurring_rules set is_active = false where id = r.id;
    end;
  end loop;
end;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION private.run_due_recurring_rules(uuid) FROM public, anon, authenticated, service_role;
