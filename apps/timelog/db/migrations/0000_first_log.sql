-- drizzle-kit never emits this: `db/schema/index.ts` does not re-export the `timelog` PgSchema.
CREATE SCHEMA "timelog";
--> statement-breakpoint
REVOKE ALL ON SCHEMA "timelog" FROM "anon", "authenticated", "service_role";
--> statement-breakpoint
GRANT USAGE ON SCHEMA "timelog" TO "authenticated";
--> statement-breakpoint
-- The next CREATE that forgets its own REVOKE concedes nothing.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA "timelog"
  REVOKE ALL ON TABLES FROM anon, authenticated, service_role;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA "timelog"
  REVOKE ALL ON FUNCTIONS FROM public, anon, authenticated, service_role;
--> statement-breakpoint
CREATE TABLE "timelog"."access_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"key_hash" "bytea" NOT NULL,
	"hint" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "access_keys_key_hash_unique" UNIQUE("key_hash"),
	CONSTRAINT "access_keys_name_length" CHECK (char_length("timelog"."access_keys"."name") between 1 and 60)
);
--> statement-breakpoint
ALTER TABLE "timelog"."access_keys" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "timelog"."app_seconds" (
	"user_id" uuid NOT NULL,
	"device" text NOT NULL,
	"day" date NOT NULL,
	"app" text NOT NULL,
	"seconds" integer NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_seconds_user_id_device_day_app_pk" PRIMARY KEY("user_id","device","day","app"),
	CONSTRAINT "app_seconds_seconds_range" CHECK ("timelog"."app_seconds"."seconds" between 1 and 86400),
	CONSTRAINT "app_seconds_device_length" CHECK (char_length("timelog"."app_seconds"."device") between 1 and 80),
	CONSTRAINT "app_seconds_app_length" CHECK (char_length("timelog"."app_seconds"."app") between 1 and 120)
);
--> statement-breakpoint
ALTER TABLE "timelog"."app_seconds" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "timelog"."allowed_emails" (
	"email" text PRIMARY KEY NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "allowed_emails_email_shape" CHECK ("timelog"."allowed_emails"."email" = lower(btrim("timelog"."allowed_emails"."email")) and position('@' in "timelog"."allowed_emails"."email") > 1)
);
--> statement-breakpoint
ALTER TABLE "timelog"."allowed_emails" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "timelog"."access_keys" ADD CONSTRAINT "access_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timelog"."app_seconds" ADD CONSTRAINT "app_seconds_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "access_keys_user_id_idx" ON "timelog"."access_keys" USING btree ("user_id");--> statement-breakpoint
CREATE POLICY "access_keys_select_self" ON "timelog"."access_keys" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((select auth.uid()) = "timelog"."access_keys"."user_id");--> statement-breakpoint
CREATE POLICY "access_keys_insert_self" ON "timelog"."access_keys" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ((select auth.uid()) = "timelog"."access_keys"."user_id");--> statement-breakpoint
CREATE POLICY "access_keys_update_self" ON "timelog"."access_keys" AS PERMISSIVE FOR UPDATE TO "authenticated" USING ((select auth.uid()) = "timelog"."access_keys"."user_id" and "timelog"."access_keys"."revoked_at" is null) WITH CHECK ((select auth.uid()) = "timelog"."access_keys"."user_id");--> statement-breakpoint
CREATE POLICY "app_seconds_select_self" ON "timelog"."app_seconds" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((select auth.uid()) = "timelog"."app_seconds"."user_id");
--> statement-breakpoint
REVOKE ALL ON TABLE "timelog"."access_keys" FROM "anon", "authenticated", "service_role";
--> statement-breakpoint
REVOKE ALL ON TABLE "timelog"."app_seconds" FROM "anon", "authenticated", "service_role";
--> statement-breakpoint
REVOKE ALL ON TABLE "timelog"."allowed_emails" FROM "anon", "authenticated", "service_role";
--> statement-breakpoint
ALTER TABLE "timelog"."access_keys" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "timelog"."app_seconds" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- `key_hash` is in no column list: the app never reads a fingerprint back.
GRANT SELECT (id, user_id, name, hint, created_at, last_used_at, revoked_at) ON TABLE "timelog"."access_keys" TO "authenticated";
--> statement-breakpoint
GRANT INSERT (user_id, name, key_hash, hint) ON TABLE "timelog"."access_keys" TO "authenticated";
--> statement-breakpoint
GRANT UPDATE (revoked_at) ON TABLE "timelog"."access_keys" TO "authenticated";
--> statement-breakpoint
GRANT SELECT ON TABLE "timelog"."app_seconds" TO "authenticated";
--> statement-breakpoint
-- The one place a key becomes a person (RT-03, RT-07). Owned by the migrating role, which bypasses RLS;
-- the app connects as that role and no API role can execute it.
CREATE FUNCTION "timelog"."person_for_key"(hash bytea)
RETURNS TABLE (user_id uuid, email text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  with live as (
    select k.id, k.user_id, k.last_used_at
      from timelog.access_keys k
     where k.key_hash = hash
       and k.revoked_at is null
  ),
  -- Stamped at most every five minutes: one MCP session sends many requests, and each would lock the row.
  stamp as (
    update timelog.access_keys k
       set last_used_at = now()
      from live
     where k.id = live.id
       and (live.last_used_at is null or live.last_used_at < now() - interval '5 minutes')
  )
  select u.id, u.email::text from live join auth.users u on u.id = live.user_id
$$;
--> statement-breakpoint
-- An upload in one statement (RT-02, RNT-02): the key is resolved, every day it names is emptied for
-- that device and refilled from `days` (`[{ day, apps: [{ app, seconds }] }]`). A day with no apps is
-- left empty. Returns the rows written, or null for a key that is unknown or revoked.
CREATE FUNCTION "timelog"."replace_days"(hash bytea, device text, days jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  person uuid;
  written integer;
begin
  select p.user_id into person from timelog.person_for_key(hash) p;
  if person is null then
    return null;
  end if;
  -- Two keys of one person can upload the same device at once.
  perform pg_advisory_xact_lock(hashtextextended(person::text || '/' || replace_days.device, 0));

  delete from timelog.app_seconds s
   where s.user_id = person
     and s.device = replace_days.device
     and s.day in (select (d ->> 'day')::date from jsonb_array_elements(days) d);

  insert into timelog.app_seconds (user_id, device, day, app, seconds)
  select person, replace_days.device, (d ->> 'day')::date, a ->> 'app', (a ->> 'seconds')::integer
    from jsonb_array_elements(days) d
   cross join jsonb_array_elements(d -> 'apps') a;
  get diagnostics written = row_count;
  return written;
end
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "timelog"."person_for_key"(bytea) FROM public, anon, authenticated, service_role;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "timelog"."replace_days"(bytea, text, jsonb) FROM public, anon, authenticated, service_role;
