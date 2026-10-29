-- 0013's body with the day split from the month (RP-61): a day moves on any row with no fact,
-- dated today, carried from a past day or not dated at all; `planned_month` keeps 0011's rule.
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
  IF NEW.estimate IS DISTINCT FROM OLD.estimate
     AND (
       EXISTS (SELECT 1 FROM goals.facts f WHERE f.one_off_id = OLD.id)
       OR EXISTS (SELECT 1 FROM goals.one_offs c WHERE c.parent_id = OLD.id)
     ) THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END
$$;
