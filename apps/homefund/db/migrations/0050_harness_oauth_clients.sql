-- Which run registered which OAuth client, so `harness:reap` can drop a dead run's clients the
-- way it drops its identities. No foreign key from `client_id` to `goals.oauth_clients`: the
-- reaper reads this row after the client behind it is gone.
create table harness.oauth_clients (
  client_id  uuid primary key,
  run_id     uuid        not null references harness.runs(id),
  created_at timestamptz not null default now()
);--> statement-breakpoint
create index harness_oauth_clients_run_idx on harness.oauth_clients (run_id);--> statement-breakpoint
-- 0039's `revoke ... on all tables` reached only the tables that existed then.
revoke all on harness.oauth_clients from anon, authenticated, service_role;
