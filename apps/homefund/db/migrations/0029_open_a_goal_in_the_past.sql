-- `savings_goals_set_timestamps` shared `private.set_row_timestamps()` with some fifteen other tables,
-- and that function overwrites `created_at` on every INSERT. A goal's ritmo is read against the straight
-- line from the day it opened (RF-87), so no fixture could open one in the past and the atrasada band
-- was left undrawn by any test. The table gets its own function: an INSERT that names `created_at`
-- keeps what it names, one that does not takes the column's own `now()` default, and an UPDATE still
-- rewrites nothing. No grant moves — the INSERT grant of 0002 never named `created_at`, so an
-- `authenticated` caller still cannot backdate a goal and the seam is open only to the owner
-- connection the harness fixtures seed over.
create or replace function private.set_savings_goal_timestamps() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    -- Null only when the INSERT names the column and hands it null; the default covers the rest.
    new.created_at := coalesce(new.created_at, pg_catalog.now());
  else
    -- A caller granted UPDATE still cannot rewrite when the row was born.
    new.created_at := old.created_at;
  end if;
  new.updated_at := pg_catalog.now();
  return new;
end;
$$;--> statement-breakpoint
revoke all on function private.set_savings_goal_timestamps() from public, anon, authenticated, service_role;--> statement-breakpoint
create or replace trigger savings_goals_set_timestamps before insert or update on "savings_goals"
  for each row execute function private.set_savings_goal_timestamps();
