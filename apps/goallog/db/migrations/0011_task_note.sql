ALTER TABLE "goals"."one_offs" ADD COLUMN "note" text;--> statement-breakpoint
ALTER TABLE "goals"."one_offs" ADD CONSTRAINT "one_offs_note_shape" CHECK ("goals"."one_offs"."note" is null or (char_length("goals"."one_offs"."note") between 1 and 2000 and "goals"."one_offs"."note" ~ '\S'));--> statement-breakpoint
ALTER POLICY "one_offs_update_self" ON "goals"."one_offs" TO authenticated USING ((select auth.uid()) = "goals"."one_offs"."user_id") WITH CHECK ((select auth.uid()) = "goals"."one_offs"."user_id" and ("goals"."one_offs"."day" is null or not exists (
        select 1 from "goals"."one_offs" c where c.parent_id = "goals"."one_offs"."id"
      )));
--> statement-breakpoint
-- RP-21's day/month rule, moved out of `using` so a note reaches a done or past
-- row. It skips the row (0 rows, what `scheduleOneOff` and `moveTaskToMonth`
-- read as «has a fact») when `day` or `planned_month` changes on a row the old
-- rule refused: a day after the person's today, and no fact.
CREATE FUNCTION "goals"."one_offs_guard_day"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF (NEW.day IS DISTINCT FROM OLD.day OR NEW.planned_month IS DISTINCT FROM OLD.planned_month)
     AND NOT (
       (OLD.day IS NULL OR OLD.day > (now() AT TIME ZONE 'America/Bogota')::date)
       AND NOT EXISTS (SELECT 1 FROM goals.facts f WHERE f.one_off_id = OLD.id)
     ) THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "one_offs_guard_day" BEFORE UPDATE ON "goals"."one_offs"
FOR EACH ROW EXECUTE FUNCTION "goals"."one_offs_guard_day"();
--> statement-breakpoint
-- `name`, `estimate` and `parent_id` stay without a grant.
GRANT INSERT (note) ON TABLE "goals"."one_offs" TO "authenticated";
--> statement-breakpoint
GRANT UPDATE (note) ON TABLE "goals"."one_offs" TO "authenticated";
