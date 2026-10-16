CREATE TABLE "audit_log" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "audit_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"entity" text NOT NULL,
	"record_id" text NOT NULL,
	"action" text NOT NULL,
	"actor_user_id" uuid,
	"owner_user_id" uuid,
	"group_id" uuid,
	"before_data" jsonb,
	"after_data" jsonb,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_log_action_valid" CHECK ("audit_log"."action" in ('INSERT', 'UPDATE', 'DELETE'))
);
--> statement-breakpoint
ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "audit_log_entity_record_id_idx" ON "audit_log" USING btree ("entity","record_id");--> statement-breakpoint
CREATE INDEX "audit_log_occurred_at_idx" ON "audit_log" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "audit_log_owner_user_id_idx" ON "audit_log" USING btree ("owner_user_id") WHERE "audit_log"."owner_user_id" is not null;--> statement-breakpoint
CREATE INDEX "audit_log_group_id_idx" ON "audit_log" USING btree ("group_id") WHERE "audit_log"."group_id" is not null;--> statement-breakpoint
-- The log is written only by the definer trigger below and purged only by the job further down. No user
-- role holds a privilege on it (RF-44): RLS is enabled but NOT forced, so the trigger, owned by the
-- table owner, still inserts while `authenticated`, granted nothing and matched by no policy, is refused
-- every operation. Confirm no `FORCE ROW LEVEL SECURITY` reintroduces itself above.
REVOKE ALL ON TABLE "audit_log" FROM anon, authenticated, service_role;--> statement-breakpoint
-- Captures every write on an audited table (RF-43/45). Runs as the owner so it lands in the locked log
-- no user role may touch; a null `auth.uid()` passes straight through and marks the row a system write.
-- The scope columns are read opportunistically from the surviving row's jsonb — absent on most child or
-- reference rows, which correctly yields null. `record_id` renders the primary key: `id` for the common
-- single-uuid tables, `account_id` for `debt_terms`, the two key columns for the composite `transaction_labels`.
create or replace function private.capture_audit() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_survivor jsonb;
  v_before jsonb;
  v_after jsonb;
  v_record_id text;
begin
  if tg_op = 'DELETE' then
    v_survivor := to_jsonb(old);
    v_before := to_jsonb(old);
    v_after := null;
  elsif tg_op = 'INSERT' then
    v_survivor := to_jsonb(new);
    v_before := null;
    v_after := to_jsonb(new);
  else
    v_survivor := to_jsonb(new);
    v_before := to_jsonb(old);
    v_after := to_jsonb(new);
  end if;

  if tg_table_name = 'transaction_labels' then
    v_record_id := (v_survivor->>'transaction_id') || ':' || (v_survivor->>'label_id');
  elsif tg_table_name = 'debt_terms' then
    v_record_id := v_survivor->>'account_id';
  else
    v_record_id := v_survivor->>'id';
  end if;

  insert into public.audit_log
    (entity, record_id, action, actor_user_id, owner_user_id, group_id, before_data, after_data, occurred_at)
  values
    (tg_table_name, v_record_id, tg_op, (select auth.uid()),
     (v_survivor->>'owner_user_id')::uuid, (v_survivor->>'group_id')::uuid,
     v_before, v_after, now());
  return null;
end;
$$;
revoke all on function private.capture_audit() from public, anon, authenticated, service_role;--> statement-breakpoint
CREATE TRIGGER capture_audit AFTER INSERT OR UPDATE OR DELETE ON "app_users"
  FOR EACH ROW EXECUTE FUNCTION private.capture_audit();--> statement-breakpoint
CREATE TRIGGER capture_audit AFTER INSERT OR UPDATE OR DELETE ON "groups"
  FOR EACH ROW EXECUTE FUNCTION private.capture_audit();--> statement-breakpoint
CREATE TRIGGER capture_audit AFTER INSERT OR UPDATE OR DELETE ON "group_members"
  FOR EACH ROW EXECUTE FUNCTION private.capture_audit();--> statement-breakpoint
CREATE TRIGGER capture_audit AFTER INSERT OR UPDATE OR DELETE ON "accounts"
  FOR EACH ROW EXECUTE FUNCTION private.capture_audit();--> statement-breakpoint
CREATE TRIGGER capture_audit AFTER INSERT OR UPDATE OR DELETE ON "categories"
  FOR EACH ROW EXECUTE FUNCTION private.capture_audit();--> statement-breakpoint
CREATE TRIGGER capture_audit AFTER INSERT OR UPDATE OR DELETE ON "transactions"
  FOR EACH ROW EXECUTE FUNCTION private.capture_audit();--> statement-breakpoint
CREATE TRIGGER capture_audit AFTER INSERT OR UPDATE OR DELETE ON "transaction_splits"
  FOR EACH ROW EXECUTE FUNCTION private.capture_audit();--> statement-breakpoint
CREATE TRIGGER capture_audit AFTER INSERT OR UPDATE OR DELETE ON "labels"
  FOR EACH ROW EXECUTE FUNCTION private.capture_audit();--> statement-breakpoint
CREATE TRIGGER capture_audit AFTER INSERT OR UPDATE OR DELETE ON "transaction_labels"
  FOR EACH ROW EXECUTE FUNCTION private.capture_audit();--> statement-breakpoint
CREATE TRIGGER capture_audit AFTER INSERT OR UPDATE OR DELETE ON "budgets"
  FOR EACH ROW EXECUTE FUNCTION private.capture_audit();--> statement-breakpoint
CREATE TRIGGER capture_audit AFTER INSERT OR UPDATE OR DELETE ON "planned_payments"
  FOR EACH ROW EXECUTE FUNCTION private.capture_audit();--> statement-breakpoint
CREATE TRIGGER capture_audit AFTER INSERT OR UPDATE OR DELETE ON "recurring_rules"
  FOR EACH ROW EXECUTE FUNCTION private.capture_audit();--> statement-breakpoint
CREATE TRIGGER capture_audit AFTER INSERT OR UPDATE OR DELETE ON "savings_goals"
  FOR EACH ROW EXECUTE FUNCTION private.capture_audit();--> statement-breakpoint
CREATE TRIGGER capture_audit AFTER INSERT OR UPDATE OR DELETE ON "goal_contributions"
  FOR EACH ROW EXECUTE FUNCTION private.capture_audit();--> statement-breakpoint
CREATE TRIGGER capture_audit AFTER INSERT OR UPDATE OR DELETE ON "debt_terms"
  FOR EACH ROW EXECUTE FUNCTION private.capture_audit();--> statement-breakpoint
CREATE TRIGGER capture_audit AFTER INSERT OR UPDATE OR DELETE ON "installment_plans"
  FOR EACH ROW EXECUTE FUNCTION private.capture_audit();--> statement-breakpoint
CREATE TRIGGER capture_audit AFTER INSERT OR UPDATE OR DELETE ON "installment_lines"
  FOR EACH ROW EXECUTE FUNCTION private.capture_audit();--> statement-breakpoint
CREATE TRIGGER capture_audit AFTER INSERT OR UPDATE OR DELETE ON "debt_statements"
  FOR EACH ROW EXECUTE FUNCTION private.capture_audit();--> statement-breakpoint
CREATE TRIGGER capture_audit AFTER INSERT OR UPDATE OR DELETE ON "webhook_credentials"
  FOR EACH ROW EXECUTE FUNCTION private.capture_audit();--> statement-breakpoint
-- Drops log rows past the RNF-14 horizon. The owner runs it, bypassing the lock the user roles hit.
create or replace function private.purge_audit_log() returns void
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.audit_log where occurred_at < now() - interval '24 months';
end;
$$;
revoke all on function private.purge_audit_log() from public, anon, authenticated, service_role;--> statement-breakpoint
-- Scheduled work runs inside the database, not as an external task (SPEC §3): a daily job purges the aged
-- rows just before the recurring generator, so the log stays bounded without any application involvement.
create extension if not exists pg_cron;--> statement-breakpoint
select cron.unschedule(jobid) from cron.job where jobname = 'purge-audit-log';--> statement-breakpoint
select cron.schedule('purge-audit-log', '45 5 * * *', $$select private.purge_audit_log()$$);
