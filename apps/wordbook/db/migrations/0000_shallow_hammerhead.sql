-- drizzle-kit never emits this: `db/schema/index.ts` re-exports the tables but
-- not the `reading` PgSchema object itself, so its schema diff never sees a
-- schema to create. Hand-written, ahead of every grant below.
CREATE SCHEMA "reading";
--> statement-breakpoint
REVOKE ALL ON SCHEMA "reading" FROM "anon", "authenticated", "service_role";
--> statement-breakpoint
GRANT USAGE ON SCHEMA "reading" TO "authenticated";
--> statement-breakpoint
-- The default shield: the next CREATE TABLE that forgets its own REVOKE
-- concedes nothing, as 0019_close_the_grant_gaps.sql:10-12 does for `public`.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA "reading"
  REVOKE ALL ON TABLES FROM anon, authenticated, service_role;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA "reading"
  REVOKE ALL ON SEQUENCES FROM anon, authenticated, service_role;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA "reading"
  REVOKE ALL ON FUNCTIONS FROM anon, authenticated, service_role;
--> statement-breakpoint
CREATE TABLE "reading"."lookups" (
	"user_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"local_id" integer NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"text" text NOT NULL,
	"normalised" text NOT NULL,
	"kind" text NOT NULL,
	"outcome" text NOT NULL,
	"headword" text,
	"rule" text,
	"senses" integer DEFAULT 0 NOT NULL,
	"translation" text,
	"dictionary_ready" boolean NOT NULL,
	"origin" text,
	"record_schema" smallint NOT NULL,
	CONSTRAINT "lookups_user_id_device_id_local_id_pk" PRIMARY KEY("user_id","device_id","local_id"),
	CONSTRAINT "lookups_local_id_positive" CHECK ("reading"."lookups"."local_id" > 0),
	CONSTRAINT "lookups_senses_non_negative" CHECK ("reading"."lookups"."senses" >= 0),
	CONSTRAINT "lookups_translation_length" CHECK (length("reading"."lookups"."translation") <= 120)
);
--> statement-breakpoint
ALTER TABLE "reading"."lookups" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "reading"."devices" (
	"user_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"label" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "devices_user_id_device_id_pk" PRIMARY KEY("user_id","device_id"),
	CONSTRAINT "devices_label_length" CHECK (length("reading"."devices"."label") between 1 and 60)
);
--> statement-breakpoint
ALTER TABLE "reading"."devices" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "reading"."lookups" ADD CONSTRAINT "lookups_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reading"."devices" ADD CONSTRAINT "devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lookups_user_id_received_at_idx" ON "reading"."lookups" USING btree ("user_id","received_at");--> statement-breakpoint
CREATE POLICY "lookups_select_self" ON "reading"."lookups" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((select auth.uid()) = "reading"."lookups"."user_id");--> statement-breakpoint
CREATE POLICY "lookups_insert_self" ON "reading"."lookups" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ((select auth.uid()) = "reading"."lookups"."user_id");--> statement-breakpoint
CREATE POLICY "lookups_delete_self" ON "reading"."lookups" AS PERMISSIVE FOR DELETE TO "authenticated" USING ((select auth.uid()) = "reading"."lookups"."user_id");--> statement-breakpoint
CREATE POLICY "devices_select_self" ON "reading"."devices" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((select auth.uid()) = "reading"."devices"."user_id");--> statement-breakpoint
CREATE POLICY "devices_insert_self" ON "reading"."devices" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ((select auth.uid()) = "reading"."devices"."user_id");--> statement-breakpoint
CREATE POLICY "devices_update_self" ON "reading"."devices" AS PERMISSIVE FOR UPDATE TO "authenticated" USING ((select auth.uid()) = "reading"."devices"."user_id") WITH CHECK ((select auth.uid()) = "reading"."devices"."user_id");--> statement-breakpoint
CREATE POLICY "devices_delete_self" ON "reading"."devices" AS PERMISSIVE FOR DELETE TO "authenticated" USING ((select auth.uid()) = "reading"."devices"."user_id");
--> statement-breakpoint
REVOKE ALL ON TABLE "reading"."lookups" FROM "anon", "authenticated", "service_role";
--> statement-breakpoint
ALTER TABLE "reading"."lookups" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT ON TABLE "reading"."lookups" TO "authenticated";
--> statement-breakpoint
-- `received_at` is NOT here: it is the download cursor and the server sets it. Nobody forges it.
GRANT INSERT (user_id, device_id, local_id, at, text, normalised, kind, outcome,
              headword, rule, senses, translation, dictionary_ready, origin,
              record_schema)
  ON TABLE "reading"."lookups" TO "authenticated";
--> statement-breakpoint
-- The only thing this slice ever deletes: retiring a device (RL-25).
-- No UPDATE, and its absence is what holds "a row is never edited".
GRANT DELETE ON TABLE "reading"."lookups" TO "authenticated";
--> statement-breakpoint
REVOKE ALL ON TABLE "reading"."devices" FROM "anon", "authenticated", "service_role";
--> statement-breakpoint
ALTER TABLE "reading"."devices" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, DELETE ON TABLE "reading"."devices" TO "authenticated";
--> statement-breakpoint
GRANT INSERT (user_id, device_id, label) ON TABLE "reading"."devices" TO "authenticated";
--> statement-breakpoint
-- The only column pushed after insert: `last_seen_at`, on every sync round.
-- `created_at` and `label` are not updated from the app.
GRANT UPDATE (last_seen_at) ON TABLE "reading"."devices" TO "authenticated";