-- 0013's body plus one rule: a row of a goal with no day is a task of its plan, whoever writes it.
CREATE OR REPLACE FUNCTION "goals"."one_offs_fill_in_plan"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF NEW.planned_month IS NOT NULL
     OR NEW.parent_id IS NOT NULL
     OR (NEW.goal_id IS NOT NULL AND NEW.day IS NULL) THEN
    NEW.in_plan := true;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
-- A done row counts too: a done task of a goal is a done task of its plan.
UPDATE "goals"."one_offs"
SET "in_plan" = true
WHERE "goal_id" IS NOT NULL AND "day" IS NULL AND "planned_month" IS NULL AND "parent_id" IS NULL AND NOT "in_plan";
