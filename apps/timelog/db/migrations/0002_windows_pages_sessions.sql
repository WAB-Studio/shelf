CREATE TABLE "timelog"."claude_sessions" (
	"user_id" uuid NOT NULL,
	"device" text NOT NULL,
	"day" date NOT NULL,
	"session" text NOT NULL,
	"project" text NOT NULL,
	"first_at" timestamp with time zone NOT NULL,
	"last_at" timestamp with time zone NOT NULL,
	"seconds" integer NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "claude_sessions_user_id_device_day_session_pk" PRIMARY KEY("user_id","device","day","session"),
	CONSTRAINT "claude_sessions_seconds_range" CHECK ("timelog"."claude_sessions"."seconds" between 1 and 86400),
	CONSTRAINT "claude_sessions_device_length" CHECK (char_length("timelog"."claude_sessions"."device") between 1 and 80),
	CONSTRAINT "claude_sessions_session_length" CHECK (char_length("timelog"."claude_sessions"."session") between 1 and 80),
	CONSTRAINT "claude_sessions_project_length" CHECK (char_length("timelog"."claude_sessions"."project") between 1 and 200)
);
--> statement-breakpoint
ALTER TABLE "timelog"."claude_sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "timelog"."page_seconds" (
	"user_id" uuid NOT NULL,
	"device" text NOT NULL,
	"day" date NOT NULL,
	"host" text NOT NULL,
	"url" text NOT NULL,
	"title" text NOT NULL,
	"seconds" integer NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "page_seconds_user_id_device_day_url_title_pk" PRIMARY KEY("user_id","device","day","url","title"),
	CONSTRAINT "page_seconds_seconds_range" CHECK ("timelog"."page_seconds"."seconds" between 1 and 86400),
	CONSTRAINT "page_seconds_device_length" CHECK (char_length("timelog"."page_seconds"."device") between 1 and 80),
	CONSTRAINT "page_seconds_host_shape" CHECK ("timelog"."page_seconds"."host" ~ '^[a-z0-9]([a-z0-9.-]{0,118}[a-z0-9])?$'),
	CONSTRAINT "page_seconds_url_shape" CHECK ("timelog"."page_seconds"."url" ~ '^https?://' and "timelog"."page_seconds"."url" !~ '[?#]' and char_length("timelog"."page_seconds"."url") <= 500),
	CONSTRAINT "page_seconds_title_length" CHECK (char_length("timelog"."page_seconds"."title") <= 300)
);
--> statement-breakpoint
ALTER TABLE "timelog"."page_seconds" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "timelog"."window_seconds" (
	"user_id" uuid NOT NULL,
	"device" text NOT NULL,
	"day" date NOT NULL,
	"app" text NOT NULL,
	"title" text NOT NULL,
	"seconds" integer NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "window_seconds_user_id_device_day_app_title_pk" PRIMARY KEY("user_id","device","day","app","title"),
	CONSTRAINT "window_seconds_seconds_range" CHECK ("timelog"."window_seconds"."seconds" between 1 and 86400),
	CONSTRAINT "window_seconds_device_length" CHECK (char_length("timelog"."window_seconds"."device") between 1 and 80),
	CONSTRAINT "window_seconds_app_length" CHECK (char_length("timelog"."window_seconds"."app") between 1 and 120),
	CONSTRAINT "window_seconds_title_length" CHECK (char_length("timelog"."window_seconds"."title") between 1 and 300)
);
--> statement-breakpoint
ALTER TABLE "timelog"."window_seconds" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "timelog"."claude_sessions" ADD CONSTRAINT "claude_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timelog"."page_seconds" ADD CONSTRAINT "page_seconds_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timelog"."window_seconds" ADD CONSTRAINT "window_seconds_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "claude_sessions_select_self" ON "timelog"."claude_sessions" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((select auth.uid()) = "timelog"."claude_sessions"."user_id");--> statement-breakpoint
CREATE POLICY "page_seconds_select_self" ON "timelog"."page_seconds" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((select auth.uid()) = "timelog"."page_seconds"."user_id");--> statement-breakpoint
CREATE POLICY "window_seconds_select_self" ON "timelog"."window_seconds" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((select auth.uid()) = "timelog"."window_seconds"."user_id");
--> statement-breakpoint
REVOKE ALL ON TABLE "timelog"."window_seconds" FROM "anon", "authenticated", "service_role";
--> statement-breakpoint
REVOKE ALL ON TABLE "timelog"."page_seconds" FROM "anon", "authenticated", "service_role";
--> statement-breakpoint
REVOKE ALL ON TABLE "timelog"."claude_sessions" FROM "anon", "authenticated", "service_role";
--> statement-breakpoint
ALTER TABLE "timelog"."window_seconds" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "timelog"."page_seconds" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "timelog"."claude_sessions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT ON TABLE "timelog"."window_seconds" TO "authenticated";
--> statement-breakpoint
GRANT SELECT ON TABLE "timelog"."page_seconds" TO "authenticated";
--> statement-breakpoint
GRANT SELECT ON TABLE "timelog"."claude_sessions" TO "authenticated";
--> statement-breakpoint
-- `replace_days` grows three more optional parts of a day (RT-18, RT-19): `windows: [{ app, title, seconds }]`,
-- `pages: [{ host, url, title, seconds }]` and `claude_sessions: [{ session, project, first, last, seconds }]`,
-- on the same rule as `sites` and `claude_code_seconds`: a part the day names replaces that device's day whole,
-- a part it does not name is left alone. Returns the rows written across every table, or null for a key that is
-- unknown or revoked.
CREATE OR REPLACE FUNCTION "timelog"."replace_days"(hash bytea, device text, days jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  person uuid;
  written integer := 0;
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
  get diagnostics more = row_count;
  written := written + more;

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

  delete from timelog.window_seconds s
   where s.user_id = person
     and s.device = replace_days.device
     and s.day in (select (d ->> 'day')::date from jsonb_array_elements(days) d where jsonb_typeof(d -> 'windows') = 'array');
  insert into timelog.window_seconds (user_id, device, day, app, title, seconds)
  select person, replace_days.device, (d ->> 'day')::date, a ->> 'app', a ->> 'title', (a ->> 'seconds')::integer
    from jsonb_array_elements(days) d
   cross join jsonb_array_elements(d -> 'windows') a
   where jsonb_typeof(d -> 'windows') = 'array';
  get diagnostics more = row_count;
  written := written + more;

  delete from timelog.page_seconds s
   where s.user_id = person
     and s.device = replace_days.device
     and s.day in (select (d ->> 'day')::date from jsonb_array_elements(days) d where jsonb_typeof(d -> 'pages') = 'array');
  insert into timelog.page_seconds (user_id, device, day, host, url, title, seconds)
  select person, replace_days.device, (d ->> 'day')::date, a ->> 'host', a ->> 'url', a ->> 'title', (a ->> 'seconds')::integer
    from jsonb_array_elements(days) d
   cross join jsonb_array_elements(d -> 'pages') a
   where jsonb_typeof(d -> 'pages') = 'array';
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
  written := written + more;

  delete from timelog.claude_sessions s
   where s.user_id = person
     and s.device = replace_days.device
     and s.day in (select (d ->> 'day')::date from jsonb_array_elements(days) d where jsonb_typeof(d -> 'claude_sessions') = 'array');
  insert into timelog.claude_sessions (user_id, device, day, session, project, first_at, last_at, seconds)
  select person, replace_days.device, (d ->> 'day')::date, a ->> 'session', a ->> 'project',
         (a ->> 'first')::timestamptz, (a ->> 'last')::timestamptz, (a ->> 'seconds')::integer
    from jsonb_array_elements(days) d
   cross join jsonb_array_elements(d -> 'claude_sessions') a
   where jsonb_typeof(d -> 'claude_sessions') = 'array';
  get diagnostics more = row_count;
  return written + more;
end
$$;
