CREATE TABLE "finances"."allowed_emails" (
	"email" text PRIMARY KEY NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "allowed_emails_email_shape" CHECK ("finances"."allowed_emails"."email" = lower(btrim("finances"."allowed_emails"."email")) and position('@' in "finances"."allowed_emails"."email") > 1)
);
--> statement-breakpoint
ALTER TABLE "finances"."allowed_emails" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "finances"."sign_in_claims" (
	"client_key" text NOT NULL,
	"day" date NOT NULL,
	"count" integer NOT NULL,
	CONSTRAINT "sign_in_claims_client_key_day_pk" PRIMARY KEY("client_key","day"),
	CONSTRAINT "sign_in_claims_count_range" CHECK ("finances"."sign_in_claims"."count" between 1 and 1000)
);
--> statement-breakpoint
ALTER TABLE "finances"."sign_in_claims" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- RF-145 and RF-143, hand-written: drizzle-kit diffs neither a grant, a seed nor a trigger. `finances` is a schema
-- Supabase did not make, so no grant arrives at CREATE TABLE; revoked all the same. No policy: only the server's
-- own pool, the tables' owner, reads or writes either one.
REVOKE ALL ON TABLE "finances"."allowed_emails" FROM "anon", "authenticated", "service_role";
--> statement-breakpoint
REVOKE ALL ON TABLE "finances"."sign_in_claims" FROM "anon", "authenticated", "service_role";
--> statement-breakpoint
-- RF-43/45: both tables are audited like every other write. Neither has an `id`, so `record_id` renders
-- its primary key: the address, or `client_key/day`. Neither row carries a scope column, so both land
-- unscoped and only their actor reads them back; a seed or a sign-in counter is a system write.
CREATE OR REPLACE FUNCTION private.capture_audit()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  elsif tg_table_name = 'allowed_emails' then
    v_record_id := v_survivor->>'email';
  elsif tg_table_name = 'sign_in_claims' then
    v_record_id := (v_survivor->>'client_key') || '/' || (v_survivor->>'day');
  else
    v_record_id := v_survivor->>'id';
  end if;

  insert into finances.audit_log
    (entity, record_id, action, actor_user_id, owner_user_id, group_id, before_data, after_data, occurred_at)
  values
    (tg_table_name, v_record_id, tg_op, (select auth.uid()),
     (v_survivor->>'owner_user_id')::uuid, (v_survivor->>'group_id')::uuid,
     v_before, v_after, now());
  return null;
end;
$function$;
--> statement-breakpoint
revoke all on function private.capture_audit() from public, anon, authenticated, service_role;
--> statement-breakpoint
-- Before the seed below, so every address it lists leaves its INSERT in the log.
CREATE TRIGGER capture_audit AFTER INSERT OR UPDATE OR DELETE ON "finances"."allowed_emails"
  FOR EACH ROW EXECUTE FUNCTION private.capture_audit();
--> statement-breakpoint
CREATE TRIGGER capture_audit AFTER INSERT OR UPDATE OR DELETE ON "finances"."sign_in_claims"
  FOR EACH ROW EXECUTE FUNCTION private.capture_audit();
--> statement-breakpoint
-- Whoever already keeps a fund here, and whoever a leader already invited, keeps asking for a link. Harness
-- identities (`.invalid`) are left out of the users; an address the CHECK would refuse is skipped rather than
-- failing the migration.
INSERT INTO "finances"."allowed_emails" ("email")
SELECT lower(btrim(u.email))
FROM auth.users u
JOIN finances.app_users a ON a.id = u.id
WHERE u.email IS NOT NULL
  AND lower(btrim(u.email)) NOT LIKE '%.invalid'
  AND position('@' in lower(btrim(u.email))) > 1
UNION
SELECT lower(btrim(m.invite_email))
FROM finances.group_members m
WHERE m.invite_email IS NOT NULL
  AND m.user_id IS NULL
  AND m.archived_at IS NULL
  AND position('@' in lower(btrim(m.invite_email))) > 1
ON CONFLICT ("email") DO NOTHING;
--> statement-breakpoint
-- A definer, because the inviting leader holds no grant on the list. It runs AFTER the row has passed
-- `group_members`' leader-only policies (RF-57, RF-100): a refused invitation never reaches it.
CREATE FUNCTION private.list_invited_email()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO finances.allowed_emails (email)
  VALUES (lower(btrim(NEW.invite_email)))
  ON CONFLICT (email) DO NOTHING;
  RETURN NULL;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION private.list_invited_email() FROM PUBLIC, "anon", "authenticated", "service_role";
--> statement-breakpoint
CREATE TRIGGER "group_members_list_invited_email" AFTER INSERT OR UPDATE OF invite_email ON "finances"."group_members"
FOR EACH ROW WHEN (NEW.invite_email IS NOT NULL) EXECUTE FUNCTION private.list_invited_email();
