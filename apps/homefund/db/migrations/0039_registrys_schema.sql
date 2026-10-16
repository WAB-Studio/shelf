-- The harness needs a place to record which run created which identity, so a killed process
-- leaves a trail another run can prove dead and reap. `harness` sits outside `public` and outside
-- the app: Supabase's automatic-RLS trigger fires on `public` only, and `capture_audit` never sees
-- these tables, so a registry that fed `audit_log` would be the bug it exists to fix.
create schema harness;--> statement-breakpoint
create table harness.runs (
  id           uuid primary key,
  lane         smallint    not null,
  suite        text        not null,
  host         text        not null,
  pid          integer     not null,
  git_branch   text,
  started_at   timestamptz not null default now(),
  heartbeat_at timestamptz not null default now(),
  finished_at  timestamptz
);--> statement-breakpoint
create index harness_runs_live_idx on harness.runs (heartbeat_at) where finished_at is null;--> statement-breakpoint
-- No foreign key from `user_id` to `auth.users`: the reaper must be able to read the registry row
-- after the identity behind it is gone.
create table harness.identities (
  user_id     uuid primary key,
  run_id      uuid references harness.runs(id) on delete cascade,
  email       text        not null,
  disposition text        not null,
  created_at  timestamptz not null default now(),
  constraint harness_identities_disposition_valid
    check (disposition in ('ephemeral', 'shared')),
  -- A shared identity outlives every run, so it hangs off none.
  constraint harness_identities_run_matches_disposition
    check ((disposition = 'shared') = (run_id is null))
);--> statement-breakpoint
create index harness_identities_run_idx on harness.identities (run_id);--> statement-breakpoint
-- Supabase grants `anon`, `authenticated` and `service_role` privileges at CREATE TABLE; withdrawn
-- at the source, same as every table in `public` (`AGENTS.md` §«Code»).
revoke all on schema harness from anon, authenticated, service_role;--> statement-breakpoint
revoke all on all tables in schema harness from anon, authenticated, service_role;
