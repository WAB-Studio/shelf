CREATE TABLE "goals"."allowed_emails" (
	"email" text PRIMARY KEY NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "allowed_emails_email_shape" CHECK ("goals"."allowed_emails"."email" = lower(btrim("goals"."allowed_emails"."email")) and position('@' in "goals"."allowed_emails"."email") > 1)
);
--> statement-breakpoint
ALTER TABLE "goals"."allowed_emails" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "goals_delete_self" ON "goals"."goals" AS PERMISSIVE FOR DELETE TO "authenticated" USING ((select auth.uid()) = "goals"."goals"."user_id" and not exists (
        select 1 from "goals"."facts" f where f.goal_id = "goals"."goals"."id"
      ) and not exists (
        select 1 from "goals"."commitments" c join "goals"."facts" f on f.commitment_id = c.id
        where c.goal_id = "goals"."goals"."id"
      ) and not exists (
        select 1 from "goals"."one_offs" o join "goals"."facts" f on f.one_off_id = o.id
        where o.goal_id = "goals"."goals"."id"
      ) and not exists (
        select 1 from "goals"."one_offs" o
        join "goals"."one_offs" s on s.parent_id = o.id
        join "goals"."facts" f on f.one_off_id = s.id
        where o.goal_id = "goals"."goals"."id"
      ));--> statement-breakpoint
CREATE POLICY "phases_update_self" ON "goals"."phases" AS PERMISSIVE FOR UPDATE TO "authenticated" USING ((select auth.uid()) = "goals"."phases"."user_id") WITH CHECK ((select auth.uid()) = "goals"."phases"."user_id");--> statement-breakpoint
CREATE POLICY "phases_delete_self" ON "goals"."phases" AS PERMISSIVE FOR DELETE TO "authenticated" USING ((select auth.uid()) = "goals"."phases"."user_id");--> statement-breakpoint
CREATE POLICY "commitments_delete_self" ON "goals"."commitments" AS PERMISSIVE FOR DELETE TO "authenticated" USING ((select auth.uid()) = "goals"."commitments"."user_id" and not exists (
        select 1 from "goals"."facts" f where f.commitment_id = "goals"."commitments"."id"
      ));
--> statement-breakpoint
-- RP-127 and RP-131, hand-written: drizzle-kit diffs neither a GRANT, a trigger nor a seed.
-- `goals` is a schema Supabase did not make, so no grant arrives at CREATE TABLE; revoked all the same.
REVOKE ALL ON TABLE "goals"."allowed_emails" FROM "anon", "authenticated", "service_role";
--> statement-breakpoint
-- Whoever already keeps a plan here keeps asking for a link (RP-131). An address the CHECK would refuse is left out
-- rather than failing the migration.
INSERT INTO "goals"."allowed_emails" ("email")
SELECT DISTINCT lower(btrim(u.email))
FROM auth.users u
WHERE u.email IS NOT NULL
  AND position('@' in lower(btrim(u.email))) > 1
  AND (
    EXISTS (SELECT 1 FROM goals.goals g WHERE g.user_id = u.id)
    OR EXISTS (SELECT 1 FROM goals.commitments c WHERE c.user_id = u.id)
    OR EXISTS (SELECT 1 FROM goals.one_offs o WHERE o.user_id = u.id)
  )
ON CONFLICT ("email") DO NOTHING;
--> statement-breakpoint
-- 0015 dropped the three delete policies for want of a grant; this is the grant.
GRANT DELETE ON TABLE "goals"."goals" TO "authenticated";
--> statement-breakpoint
GRANT DELETE ON TABLE "goals"."phases" TO "authenticated";
--> statement-breakpoint
GRANT UPDATE ("aim", "starts_on", "ends_on") ON TABLE "goals"."phases" TO "authenticated";
--> statement-breakpoint
GRANT DELETE ON TABLE "goals"."commitments" TO "authenticated";
--> statement-breakpoint
GRANT UPDATE ("cadence_kind", "cadence_n", "cadence_weekdays") ON TABLE "goals"."commitments" TO "authenticated";
--> statement-breakpoint
-- A trigger, not a policy: `commitments_update_self` covers every column, and `retired_at`, `name` and `note` still
-- move on a commitment a fact names. Raises rather than skipping the row, so the action can say why. Loose habits too.
CREATE FUNCTION "goals"."commitments_guard_cadence"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF OLD.retired_at IS NOT NULL THEN
    RAISE EXCEPTION 'a retired commitment keeps its cadence' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM goals.facts f WHERE f.commitment_id = OLD.id) THEN
    RAISE EXCEPTION 'a commitment a fact names keeps its cadence' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "commitments_guard_cadence" BEFORE UPDATE OF cadence_kind, cadence_n, cadence_weekdays ON "goals"."commitments"
FOR EACH ROW EXECUTE FUNCTION "goals"."commitments_guard_cadence"();