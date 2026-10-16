-- No back-fill: not one `rejected` delivery exists, so `default false` is exact for every row. Should
-- one land before this applies, `false` reads it as a person's decision and a restore leaves it alone —
-- the conservative direction.
ALTER TABLE "ingest_deliveries" ADD COLUMN "silenced_on_arrival" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "ingest_deliveries" ADD CONSTRAINT "ingest_deliveries_silenced_only_when_rejected" CHECK ("ingest_deliveries"."silenced_on_arrival" = false or "ingest_deliveries"."status" = 'rejected');--> statement-breakpoint
-- Stated rather than inferred from absence: `ADD COLUMN` is not a `CREATE TABLE`, so Supabase's default
-- privileges never fired here, and 0012 left no table-level privilege for a new column to ride on.
revoke all (silenced_on_arrival) on table "ingest_deliveries" from anon, authenticated, service_role;--> statement-breakpoint
-- SELECT because the restore filters on the flag and Postgres checks column privileges in a `WHERE`;
-- UPDATE because the check above forces the restore to clear it. No INSERT: the column joins `status`,
-- `owner_user_id` and `resolved_at` as one no caller can name.
grant select (silenced_on_arrival), update (silenced_on_arrival) on table "ingest_deliveries" to authenticated;--> statement-breakpoint
-- The database decides land-versus-silence, never the caller (RF-92): the owner is stamped from the
-- session, and the shape memory under that owner settles the status. A shape the person silenced arrives
-- already rejected; an approved shape, or one never seen, waits for review. `status` and `resolved_at`
-- are outside the INSERT grant, so no caller can bypass this by naming them. The flag says who decided,
-- so RF-99 can undo the machine's rejection without undoing a person's.
create or replace function private.set_ingest_delivery_state() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_decision text;
begin
  new.owner_user_id := (select auth.uid());
  select s.decision into v_decision from public.ingest_shapes s
    where s.owner_user_id = new.owner_user_id and s.shape_hash = new.shape_hash;
  if v_decision = 'rejected' then
    new.status := 'rejected';
    new.resolved_at := pg_catalog.now();
    new.silenced_on_arrival := true;
  else
    new.status := 'pending';
    new.resolved_at := null;
    new.silenced_on_arrival := false;
  end if;
  return new;
end;
$$;--> statement-breakpoint
revoke all on function private.set_ingest_delivery_state() from public, anon, authenticated, service_role;
