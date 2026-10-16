ALTER TABLE "goals"."goals" ADD COLUMN "rhythm" integer;--> statement-breakpoint
ALTER TABLE "goals"."goals" ADD COLUMN "plan_seen" date;--> statement-breakpoint
ALTER TABLE "goals"."one_offs" ADD COLUMN "in_plan" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- The data move: every row with a month or a parent is a plan task; `planned_month` is not touched,
-- so no task changes month. It runs before the checks that need the flag.
UPDATE "goals"."one_offs" SET "in_plan" = true WHERE "planned_month" IS NOT NULL OR "parent_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "goals"."goals" ADD CONSTRAINT "goals_rhythm_range" CHECK ("goals"."goals"."rhythm" is null or ("goals"."goals"."rhythm" between 1 and 1000000 and "goals"."goals"."measure_unit" is not null));--> statement-breakpoint
ALTER TABLE "goals"."goals" ADD CONSTRAINT "goals_plan_seen_first_day" CHECK ("goals"."goals"."plan_seen" is null or "goals"."goals"."plan_seen" = date_trunc('month', "goals"."goals"."plan_seen")::date);--> statement-breakpoint
ALTER TABLE "goals"."one_offs" ADD CONSTRAINT "one_offs_in_plan_shape" CHECK (not "goals"."one_offs"."in_plan" or "goals"."one_offs"."goal_id" is not null);--> statement-breakpoint
ALTER TABLE "goals"."one_offs" ADD CONSTRAINT "one_offs_planned_month_in_plan" CHECK ("goals"."one_offs"."planned_month" is null or "goals"."one_offs"."in_plan");--> statement-breakpoint
ALTER TABLE "goals"."one_offs" ADD CONSTRAINT "one_offs_child_in_plan" CHECK ("goals"."one_offs"."parent_id" is null or "goals"."one_offs"."in_plan");--> statement-breakpoint
ALTER POLICY "one_offs_insert_self" ON "goals"."one_offs" TO authenticated WITH CHECK ((select auth.uid()) = "goals"."one_offs"."user_id" and ("goals"."one_offs"."parent_id" is null or exists (
        select 1 from "goals"."one_offs" p
        where p.id = "goals"."one_offs"."parent_id" and p.parent_id is null and p.in_plan
          and p.day is null and p.estimate is null and p.goal_id = "goals"."one_offs"."goal_id"
          and not exists (select 1 from "goals"."facts" f where f.one_off_id = p.id)
      )));
--> statement-breakpoint
CREATE FUNCTION "goals"."one_offs_fill_in_plan"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF NEW.planned_month IS NOT NULL OR NEW.parent_id IS NOT NULL THEN
    NEW.in_plan := true;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "one_offs_fill_in_plan" BEFORE INSERT ON "goals"."one_offs"
FOR EACH ROW EXECUTE FUNCTION "goals"."one_offs_fill_in_plan"();
--> statement-breakpoint
-- 0011's body plus one rule: `estimate` also stays put on a row with a fact or with children (0 rows, as for a day).
CREATE OR REPLACE FUNCTION "goals"."one_offs_guard_day"()
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
--> statement-breakpoint
-- drizzle-kit does not diff a GRANT. `in_plan` has no UPDATE grant: set at insert, never changed.
GRANT INSERT (in_plan) ON TABLE "goals"."one_offs" TO "authenticated";
--> statement-breakpoint
GRANT UPDATE (name, estimate) ON TABLE "goals"."one_offs" TO "authenticated";
--> statement-breakpoint
GRANT UPDATE (rhythm, plan_seen) ON TABLE "goals"."goals" TO "authenticated";
