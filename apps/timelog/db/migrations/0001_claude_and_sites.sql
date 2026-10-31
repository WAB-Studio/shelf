CREATE TABLE "timelog"."claude_code_seconds" (
	"user_id" uuid NOT NULL,
	"device" text NOT NULL,
	"day" date NOT NULL,
	"seconds" integer NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "claude_code_seconds_user_id_device_day_pk" PRIMARY KEY("user_id","device","day"),
	CONSTRAINT "claude_code_seconds_seconds_range" CHECK ("timelog"."claude_code_seconds"."seconds" between 1 and 86400),
	CONSTRAINT "claude_code_seconds_device_length" CHECK (char_length("timelog"."claude_code_seconds"."device") between 1 and 80)
);
--> statement-breakpoint
ALTER TABLE "timelog"."claude_code_seconds" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "timelog"."site_seconds" (
	"user_id" uuid NOT NULL,
	"device" text NOT NULL,
	"day" date NOT NULL,
	"host" text NOT NULL,
	"seconds" integer NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "site_seconds_user_id_device_day_host_pk" PRIMARY KEY("user_id","device","day","host"),
	CONSTRAINT "site_seconds_seconds_range" CHECK ("timelog"."site_seconds"."seconds" between 1 and 86400),
	CONSTRAINT "site_seconds_device_length" CHECK (char_length("timelog"."site_seconds"."device") between 1 and 80),
	CONSTRAINT "site_seconds_host_shape" CHECK ("timelog"."site_seconds"."host" ~ '^[a-z0-9]([a-z0-9.-]{0,118}[a-z0-9])?$')
);
--> statement-breakpoint
ALTER TABLE "timelog"."site_seconds" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "timelog"."claude_code_seconds" ADD CONSTRAINT "claude_code_seconds_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timelog"."site_seconds" ADD CONSTRAINT "site_seconds_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "claude_code_seconds_select_self" ON "timelog"."claude_code_seconds" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((select auth.uid()) = "timelog"."claude_code_seconds"."user_id");--> statement-breakpoint
CREATE POLICY "site_seconds_select_self" ON "timelog"."site_seconds" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((select auth.uid()) = "timelog"."site_seconds"."user_id");
--> statement-breakpoint
REVOKE ALL ON TABLE "timelog"."site_seconds" FROM "anon", "authenticated", "service_role";
--> statement-breakpoint
REVOKE ALL ON TABLE "timelog"."claude_code_seconds" FROM "anon", "authenticated", "service_role";
--> statement-breakpoint
ALTER TABLE "timelog"."site_seconds" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "timelog"."claude_code_seconds" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT ON TABLE "timelog"."site_seconds" TO "authenticated";
--> statement-breakpoint
GRANT SELECT ON TABLE "timelog"."claude_code_seconds" TO "authenticated";
--> statement-breakpoint
-- `replace_days` grows two optional parts of a day (RT-13, RT-14): `sites: [{ host, seconds }]` and
-- `claude_code_seconds`. A day that names the part replaces it whole for that device (a zero removes the
-- Claude Code row); a day that does not name it leaves it alone, which is every old uploader's payload.
-- Returns the rows written across the three tables, or null for a key that is unknown or revoked.
CREATE OR REPLACE FUNCTION "timelog"."replace_days"(hash bytea, device text, days jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  person uuid;
  written integer;
  more integer;
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

  delete from timelog.site_seconds s
   where s.user_id = person
     and s.device = replace_days.device
     and s.day in (select (d ->> 'day')::date from jsonb_array_elements(days) d where jsonb_typeof(d -> 'sites') = 'array');

  insert into timelog.site_seconds (user_id, device, day, host, seconds)
  select person, replace_days.device, (d ->> 'day')::date, a ->> 'host', (a ->> 'seconds')::integer
    from jsonb_array_elements(days) d
   cross join jsonb_array_elements(d -> 'sites') a
   where jsonb_typeof(d -> 'sites') = 'array';
  get diagnostics more = row_count;
  written := written + more;

  delete from timelog.claude_code_seconds s
   where s.user_id = person
     and s.device = replace_days.device
     and s.day in (select (d ->> 'day')::date from jsonb_array_elements(days) d where jsonb_typeof(d -> 'claude_code_seconds') = 'number');

  insert into timelog.claude_code_seconds (user_id, device, day, seconds)
  select person, replace_days.device, (d ->> 'day')::date, (d ->> 'claude_code_seconds')::integer
    from jsonb_array_elements(days) d
   where jsonb_typeof(d -> 'claude_code_seconds') = 'number'
     and (d ->> 'claude_code_seconds')::integer > 0;
  get diagnostics more = row_count;
  return written + more;
end
$$;
