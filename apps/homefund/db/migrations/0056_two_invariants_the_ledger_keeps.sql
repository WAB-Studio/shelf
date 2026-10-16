-- An account's settlement currency is the unit its opening balance and every leg are counted in.
-- Changing it once the account has any movement or reconciliation re-denominates the opening amount
-- and strands the history in the old currency (AC001). A trigger carries it because the column is
-- granted for update since 0031 and the edit form offers the picker. Security definer: the history
-- may sit in rows the caller's policies do not show. A session with no history changes it freely.
create or replace function private.assert_settlement_currency_holds() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.settlement_currency is distinct from old.settlement_currency
     and (exists (select 1 from finances.transactions t
                  where t.from_account_id = old.id or t.to_account_id = old.id)
          or exists (select 1 from finances.account_reconciliations r where r.account_id = old.id)) then
    raise exception 'an account with movements keeps its settlement currency' using errcode = 'AC001';
  end if;
  return new;
end;
$$;--> statement-breakpoint
revoke all on function private.assert_settlement_currency_holds() from public, anon, authenticated, service_role;--> statement-breakpoint
create trigger accounts_settlement_currency_holds before update of settlement_currency on finances.accounts
  for each row execute function private.assert_settlement_currency_holds();
--> statement-breakpoint
-- A recurring rule's cursor only moves forward past what it already booked: a `next_run_on` at or
-- before the latest movement the rule generated makes the cron back-fill those periods again, and
-- nothing else forbids the duplicate (RR001). The cron itself only advances the cursor, so it passes.
create or replace function private.assert_rule_cursor_moves_forward() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.next_run_on is distinct from old.next_run_on
     and new.next_run_on <= (select max(t.occurred_at) from finances.transactions t
                             where t.recurring_rule_id = old.id) then
    raise exception 'a recurring rule cannot run again for a period it already booked' using errcode = 'RR001';
  end if;
  return new;
end;
$$;--> statement-breakpoint
revoke all on function private.assert_rule_cursor_moves_forward() from public, anon, authenticated, service_role;--> statement-breakpoint
create trigger recurring_rules_cursor_moves_forward before update of next_run_on on finances.recurring_rules
  for each row execute function private.assert_rule_cursor_moves_forward();
