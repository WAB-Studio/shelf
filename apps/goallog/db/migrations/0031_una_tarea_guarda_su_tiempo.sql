ALTER TABLE "goals"."one_offs" ADD COLUMN "spent_minutes" integer;--> statement-breakpoint
ALTER TABLE "goals"."one_offs" ADD CONSTRAINT "one_offs_spent_minutes_positive" CHECK ("goals"."one_offs"."spent_minutes" is null or "goals"."one_offs"."spent_minutes" > 0);--> statement-breakpoint
GRANT UPDATE (spent_minutes) ON TABLE "goals"."one_offs" TO "authenticated";
--> statement-breakpoint
-- 0017's body plus one rule: `spent_minutes` stays put on a row with a fact (0 rows, as for an estimate).
CREATE OR REPLACE FUNCTION "goals"."one_offs_guard_day"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF NEW.day IS DISTINCT FROM OLD.day
     AND EXISTS (SELECT 1 FROM goals.facts f WHERE f.one_off_id = OLD.id) THEN
    RETURN NULL;
  END IF;
  IF NEW.planned_month IS DISTINCT FROM OLD.planned_month
     AND NOT (
       (OLD.day IS NULL OR OLD.day > (now() AT TIME ZONE 'America/Bogota')::date)
       AND NOT EXISTS (SELECT 1 FROM goals.facts f WHERE f.one_off_id = OLD.id)
     ) THEN
    RETURN NULL;
  END IF;
  IF (NEW.estimate IS DISTINCT FROM OLD.estimate OR NEW.spent_minutes IS DISTINCT FROM OLD.spent_minutes)
     AND (
       EXISTS (SELECT 1 FROM goals.facts f WHERE f.one_off_id = OLD.id)
       OR EXISTS (SELECT 1 FROM goals.one_offs c WHERE c.parent_id = OLD.id)
     ) THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END
$$;
