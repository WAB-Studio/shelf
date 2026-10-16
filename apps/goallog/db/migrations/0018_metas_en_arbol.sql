ALTER TABLE "goals"."goals" ADD COLUMN "parent_id" uuid;--> statement-breakpoint
ALTER TABLE "goals"."goals" ADD COLUMN "note" text;--> statement-breakpoint
ALTER TABLE "goals"."goals" ADD CONSTRAINT "goals_parent_id_goals_id_fk" FOREIGN KEY ("parent_id") REFERENCES "goals"."goals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "goals_parent_id_idx" ON "goals"."goals" USING btree ("parent_id");--> statement-breakpoint
ALTER TABLE "goals"."goals" ADD CONSTRAINT "goals_not_own_parent" CHECK ("goals"."goals"."parent_id" <> "goals"."goals"."id");--> statement-breakpoint
ALTER TABLE "goals"."goals" ADD CONSTRAINT "goals_note_shape" CHECK ("goals"."goals"."note" is null or (char_length("goals"."goals"."note") between 1 and 20000 and "goals"."goals"."note" ~ '\S'));--> statement-breakpoint
ALTER POLICY "goals_select_self" ON "goals"."goals" TO authenticated USING (auth.uid() = "goals"."goals"."user_id");--> statement-breakpoint
ALTER POLICY "goals_insert_self" ON "goals"."goals" TO authenticated WITH CHECK ((select auth.uid()) = "goals"."goals"."user_id" and ("goals"."goals"."parent_id" is null or exists (
        select 1 from "goals"."goals" p where p.id = "goals"."goals"."parent_id"
      )));--> statement-breakpoint
ALTER POLICY "goals_update_self" ON "goals"."goals" TO authenticated USING ((select auth.uid()) = "goals"."goals"."user_id") WITH CHECK ((select auth.uid()) = "goals"."goals"."user_id" and ("goals"."goals"."parent_id" is null or exists (
        select 1 from "goals"."goals" p where p.id = "goals"."goals"."parent_id"
      )));
--> statement-breakpoint
-- RP-78–RP-80's shape of the tree, hand-written: drizzle-kit diffs neither a trigger nor a GRANT.
-- Every walk filters on the row's own `user_id`: SECURITY INVOKER sees only the caller's rows under
-- RLS, but not as the owner. A parent the walk does not find is left to `goals_insert_self` and
-- `goals_update_self` (42501), and `parent_id = id` to `goals_not_own_parent`.
CREATE FUNCTION "goals"."goals_guard_tree"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  parent_found boolean := false;
  parent_horizon date;
  parent_depth integer := 0;
  in_cycle boolean := false;
  branch_height integer := 1;
  blocker uuid;
  moved boolean := true;
  horizon_moved boolean := false;
  rhythm_set boolean := false;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    moved := NEW.parent_id IS DISTINCT FROM OLD.parent_id;
    horizon_moved := NEW.horizon IS DISTINCT FROM OLD.horizon;
    rhythm_set := NEW.rhythm IS NOT NULL AND NEW.rhythm IS DISTINCT FROM OLD.rhythm;
    IF NOT moved AND NOT horizon_moved AND NEW.rhythm IS NOT DISTINCT FROM OLD.rhythm THEN
      RETURN NEW;
    END IF;
  END IF;

  IF NEW.parent_id IS NOT NULL AND NEW.parent_id <> NEW.id THEN
    -- The chain from the new parent up to its top goal, stopped at this row if it sits there.
    WITH RECURSIVE up (id, parent_id, horizon, n) AS (
      SELECT g.id, g.parent_id, g.horizon, 1
        FROM goals.goals g
       WHERE g.id = NEW.parent_id AND g.user_id = NEW.user_id
      UNION ALL
      SELECT g.id, g.parent_id, g.horizon, up.n + 1
        FROM goals.goals g
        JOIN up ON g.id = up.parent_id
       WHERE g.user_id = NEW.user_id AND up.id <> NEW.id AND up.n < 32
    )
    SELECT count(*) > 0, max(up.horizon) FILTER (WHERE up.n = 1), count(*), coalesce(bool_or(up.id = NEW.id), false)
      INTO parent_found, parent_horizon, parent_depth, in_cycle
      FROM up;

    IF in_cycle THEN
      RAISE EXCEPTION 'goal % cannot sit under one of its own goals', NEW.id
        USING ERRCODE = '23514', CONSTRAINT = 'goals_tree_cycle', DETAIL = NEW.parent_id::text;
    END IF;

    IF parent_found AND moved THEN
      WITH RECURSIVE down (id, n) AS (
        SELECT NEW.id, 1
        UNION ALL
        SELECT g.id, down.n + 1
          FROM goals.goals g
          JOIN down ON g.parent_id = down.id
         WHERE g.user_id = NEW.user_id AND down.n < 32
      )
      SELECT max(down.n) INTO branch_height FROM down;

      IF parent_depth + branch_height > 3 THEN
        RAISE EXCEPTION 'goal % would sit % levels deep', NEW.id, parent_depth + branch_height
          USING ERRCODE = '23514', CONSTRAINT = 'goals_tree_depth', DETAIL = NEW.parent_id::text;
      END IF;
    END IF;

    IF parent_found AND NEW.horizon > parent_horizon THEN
      RAISE EXCEPTION 'goal % ends after the goal above it', NEW.id
        USING ERRCODE = '23514', CONSTRAINT = 'goals_tree_end', DETAIL = NEW.parent_id::text;
    END IF;
  END IF;

  IF horizon_moved THEN
    SELECT c.id INTO blocker
      FROM goals.goals c
     WHERE c.parent_id = NEW.id AND c.user_id = NEW.user_id AND c.horizon > NEW.horizon
     ORDER BY c.horizon DESC, c.id
     LIMIT 1;
    IF blocker IS NOT NULL THEN
      RAISE EXCEPTION 'goal % ends after the new horizon of goal %', blocker, NEW.id
        USING ERRCODE = '23514', CONSTRAINT = 'goals_tree_end', DETAIL = blocker::text;
    END IF;
  END IF;

  -- P2 = B: a rhythm already stored stays, unread; only setting one on a goal that holds goals is refused.
  IF rhythm_set AND EXISTS (
       SELECT 1 FROM goals.goals c
        WHERE c.parent_id = NEW.id AND c.user_id = NEW.user_id AND c.archived_at IS NULL
     ) THEN
    RAISE EXCEPTION 'goal % holds goals and takes no rhythm', NEW.id
      USING ERRCODE = '23514', CONSTRAINT = 'goals_tree_rhythm', DETAIL = NEW.id::text;
  END IF;

  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "goals_guard_tree" BEFORE INSERT OR UPDATE OF parent_id, horizon, rhythm ON "goals"."goals"
FOR EACH ROW EXECUTE FUNCTION "goals"."goals_guard_tree"();
--> statement-breakpoint
-- RP-80: a goal that holds goals takes no month amounts of its own. Amounts it stored before stay, unread.
CREATE FUNCTION "goals"."month_budgets_guard_holder"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM goals.goals c
     WHERE c.parent_id = NEW.goal_id AND c.user_id = NEW.user_id AND c.archived_at IS NULL
  ) THEN
    RAISE EXCEPTION 'goal % holds goals and takes no month amounts', NEW.goal_id
      USING ERRCODE = '23514', CONSTRAINT = 'month_budgets_holder', DETAIL = NEW.goal_id::text;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "month_budgets_guard_holder" BEFORE INSERT OR UPDATE ON "goals"."month_budgets"
FOR EACH ROW EXECUTE FUNCTION "goals"."month_budgets_guard_holder"();
--> statement-breakpoint
GRANT INSERT (parent_id, note) ON TABLE "goals"."goals" TO "authenticated";
--> statement-breakpoint
GRANT UPDATE (parent_id, note) ON TABLE "goals"."goals" TO "authenticated";
