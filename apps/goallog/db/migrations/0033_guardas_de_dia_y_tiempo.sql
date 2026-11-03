-- Second line behind the actions: a day's own target (RP-148) and a task's recorded time (RP-147) sit only where the actions put them.
CREATE OR REPLACE FUNCTION "goals"."facts_guard_day_target"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF NEW.day_target IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM goals.commitments c
    WHERE c.id = NEW.commitment_id
      AND c.satisfaction = 'quantity'
      AND c.target_quantity IS NOT NULL
      AND NEW.day_target < c.target_quantity
  ) THEN
    RAISE EXCEPTION 'a day target belongs to a quantity commitment and stays below its target'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "facts_guard_day_target" BEFORE INSERT ON "goals"."facts"
FOR EACH ROW EXECUTE FUNCTION "goals"."facts_guard_day_target"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "goals"."one_offs_guard_spent"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF NEW.estimate IS NULL OR NOT EXISTS (
    SELECT 1 FROM goals.goals g
    WHERE g.id = NEW.goal_id
      AND lower(btrim(g.measure_unit)) IN ('minutos', 'minuto', 'min', 'mins')
  ) THEN
    RAISE EXCEPTION 'recorded time belongs to a task estimated in a goal measured in time'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "one_offs_guard_spent" BEFORE UPDATE OF spent_minutes ON "goals"."one_offs"
FOR EACH ROW WHEN (NEW.spent_minutes IS NOT NULL AND NEW.spent_minutes IS DISTINCT FROM OLD.spent_minutes)
EXECUTE FUNCTION "goals"."one_offs_guard_spent"();
