ALTER TABLE "goals"."goals" ALTER COLUMN "horizon" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "goals"."commitments" ALTER COLUMN "goal_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "goals"."commitments" ADD COLUMN "note" text;--> statement-breakpoint
ALTER TABLE "goals"."commitments" ADD CONSTRAINT "commitments_note_shape" CHECK ("goals"."commitments"."note" is null or (char_length("goals"."commitments"."note") between 1 and 2000 and "goals"."commitments"."note" ~ '\S'));--> statement-breakpoint
ALTER POLICY "commitments_insert_self" ON "goals"."commitments" TO authenticated WITH CHECK ((select auth.uid()) = "goals"."commitments"."user_id" and ("goals"."commitments"."goal_id" is null or exists (
        select 1 from "goals"."goals" g where g.id = "goals"."commitments"."goal_id"
      )));
--> statement-breakpoint
-- RP-99: a goal may have no end. With a NULL, 0018's two comparisons give NULL and let through what RP-99
-- forbids, so the function is rewritten whole; the body is 0018's with the two NULL branches marked.
CREATE OR REPLACE FUNCTION "goals"."goals_guard_tree"()
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

    IF parent_found AND (NEW.horizon > parent_horizon OR (NEW.horizon IS NULL AND parent_horizon IS NOT NULL)) THEN
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

    -- A goal with no end cannot sit inside one that has it (RP-99): giving the one above an end names the one inside.
    IF NEW.horizon IS NOT NULL THEN
      SELECT c.id INTO blocker
        FROM goals.goals c
       WHERE c.parent_id = NEW.id AND c.user_id = NEW.user_id AND c.horizon IS NULL
       ORDER BY c.id
       LIMIT 1;
      IF blocker IS NOT NULL THEN
        RAISE EXCEPTION 'goal % has no end and sits in goal %, which now has one', blocker, NEW.id
          USING ERRCODE = '23514', CONSTRAINT = 'goals_tree_no_end', DETAIL = blocker::text;
      END IF;
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
-- A habit's note takes the task note's grants (RP-88). `goal_id` stays without an UPDATE grant.
GRANT INSERT (note) ON TABLE "goals"."commitments" TO "authenticated";
--> statement-breakpoint
GRANT UPDATE (note) ON TABLE "goals"."commitments" TO "authenticated";
