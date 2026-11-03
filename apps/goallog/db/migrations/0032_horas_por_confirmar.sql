CREATE TABLE "goals"."time_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"entry_id" uuid NOT NULL,
	"goal_id" uuid NOT NULL,
	"minutes" integer NOT NULL,
	CONSTRAINT "time_allocations_minutes_range" CHECK ("goals"."time_allocations"."minutes" between 1 and 1000000)
);
--> statement-breakpoint
ALTER TABLE "goals"."time_allocations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "goals"."time_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"day" date NOT NULL,
	"minutes" integer NOT NULL,
	"source" text NOT NULL,
	"one_off_id" uuid,
	"suggested_goal_id" uuid,
	"note" text,
	"dismissed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "time_entries_minutes_range" CHECK ("goals"."time_entries"."minutes" between 1 and 1000000),
	CONSTRAINT "time_entries_source_known" CHECK ("goals"."time_entries"."source" in ('task', 'chat', 'timelog')),
	CONSTRAINT "time_entries_note_shape" CHECK ("goals"."time_entries"."note" is null or char_length("goals"."time_entries"."note") between 1 and 280)
);
--> statement-breakpoint
ALTER TABLE "goals"."time_entries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "goals"."time_allocations" ADD CONSTRAINT "time_allocations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goals"."time_allocations" ADD CONSTRAINT "time_allocations_entry_id_time_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "goals"."time_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goals"."time_allocations" ADD CONSTRAINT "time_allocations_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "goals"."goals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goals"."time_entries" ADD CONSTRAINT "time_entries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goals"."time_entries" ADD CONSTRAINT "time_entries_one_off_id_one_offs_id_fk" FOREIGN KEY ("one_off_id") REFERENCES "goals"."one_offs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goals"."time_entries" ADD CONSTRAINT "time_entries_suggested_goal_id_goals_id_fk" FOREIGN KEY ("suggested_goal_id") REFERENCES "goals"."goals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "time_allocations_entry_id_idx" ON "goals"."time_allocations" USING btree ("entry_id");--> statement-breakpoint
CREATE INDEX "time_allocations_goal_id_idx" ON "goals"."time_allocations" USING btree ("goal_id");--> statement-breakpoint
CREATE INDEX "time_entries_user_id_day_idx" ON "goals"."time_entries" USING btree ("user_id","day");--> statement-breakpoint
CREATE INDEX "time_entries_one_off_id_idx" ON "goals"."time_entries" USING btree ("one_off_id");--> statement-breakpoint
CREATE POLICY "time_allocations_select_self" ON "goals"."time_allocations" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((select auth.uid()) = "goals"."time_allocations"."user_id");--> statement-breakpoint
CREATE POLICY "time_allocations_insert_self" ON "goals"."time_allocations" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ((select auth.uid()) = "goals"."time_allocations"."user_id" and exists (
        select 1 from "goals"."time_entries" e where e.id = "goals"."time_allocations"."entry_id" and e.dismissed_at is null
      ) and exists (
        select 1 from "goals"."goals" g where g.id = "goals"."time_allocations"."goal_id"
      ));--> statement-breakpoint
CREATE POLICY "time_allocations_delete_self" ON "goals"."time_allocations" AS PERMISSIVE FOR DELETE TO "authenticated" USING ((select auth.uid()) = "goals"."time_allocations"."user_id");--> statement-breakpoint
CREATE POLICY "time_entries_select_self" ON "goals"."time_entries" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((select auth.uid()) = "goals"."time_entries"."user_id");--> statement-breakpoint
CREATE POLICY "time_entries_insert_self" ON "goals"."time_entries" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ((select auth.uid()) = "goals"."time_entries"."user_id" and ("goals"."time_entries"."one_off_id" is null or exists (
        select 1 from "goals"."one_offs" o where o.id = "goals"."time_entries"."one_off_id"
      )) and ("goals"."time_entries"."suggested_goal_id" is null or exists (
        select 1 from "goals"."goals" g where g.id = "goals"."time_entries"."suggested_goal_id"
      )));--> statement-breakpoint
CREATE POLICY "time_entries_update_self" ON "goals"."time_entries" AS PERMISSIVE FOR UPDATE TO "authenticated" USING ((select auth.uid()) = "goals"."time_entries"."user_id") WITH CHECK ((select auth.uid()) = "goals"."time_entries"."user_id");--> statement-breakpoint
CREATE POLICY "time_entries_delete_self" ON "goals"."time_entries" AS PERMISSIVE FOR DELETE TO "authenticated" USING ((select auth.uid()) = "goals"."time_entries"."user_id");--> statement-breakpoint
-- RP-151, RNP-05, hand-written: drizzle-kit diffs neither a GRANT nor a function. `goals` is a schema Supabase did not
-- make, so no grant arrives at CREATE TABLE; revoked all the same.
REVOKE ALL ON TABLE "goals"."time_entries" FROM "anon", "authenticated", "service_role";
--> statement-breakpoint
REVOKE ALL ON TABLE "goals"."time_allocations" FROM "anon", "authenticated", "service_role";
--> statement-breakpoint
GRANT SELECT, DELETE ON TABLE "goals"."time_entries" TO "authenticated";
--> statement-breakpoint
-- `created_at` is the server's clock, never the caller's.
GRANT INSERT (id, user_id, day, minutes, source, one_off_id, suggested_goal_id, note) ON TABLE "goals"."time_entries" TO "authenticated";
--> statement-breakpoint
GRANT UPDATE (day, minutes, dismissed_at) ON TABLE "goals"."time_entries" TO "authenticated";
--> statement-breakpoint
-- An allocation is written once and removed whole: no UPDATE.
GRANT SELECT, DELETE ON TABLE "goals"."time_allocations" TO "authenticated";
--> statement-breakpoint
GRANT INSERT (id, user_id, entry_id, goal_id, minutes) ON TABLE "goals"."time_allocations" TO "authenticated";
--> statement-breakpoint
-- The sum of an entry's allocations never passes its minutes; the action settles the entry whole, the trigger holds
-- it for any other door. Entries are locked by the insert's own row lock on the entry, so two splits queue.
CREATE FUNCTION "goals"."time_allocations_within_entry"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  entry_minutes integer;
  allocated integer;
BEGIN
  SELECT e.minutes INTO entry_minutes FROM goals.time_entries e WHERE e.id = NEW.entry_id FOR UPDATE;
  SELECT coalesce(sum(a.minutes), 0) INTO allocated FROM goals.time_allocations a WHERE a.entry_id = NEW.entry_id;
  IF allocated + NEW.minutes > entry_minutes THEN
    RAISE EXCEPTION 'time_allocations_within_entry' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "time_allocations_within_entry" BEFORE INSERT ON "goals"."time_allocations"
FOR EACH ROW EXECUTE FUNCTION "goals"."time_allocations_within_entry"();
--> statement-breakpoint
-- Minutes and dismissal change only on an entry nothing was allocated from: 0 rows, as `one_offs_guard_day` does.
CREATE FUNCTION "goals"."time_entries_guard_update"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF (NEW.minutes IS DISTINCT FROM OLD.minutes OR NEW.dismissed_at IS NOT NULL)
     AND EXISTS (SELECT 1 FROM goals.time_allocations a WHERE a.entry_id = OLD.id) THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "time_entries_guard_update" BEFORE UPDATE ON "goals"."time_entries"
FOR EACH ROW EXECUTE FUNCTION "goals"."time_entries_guard_update"();
