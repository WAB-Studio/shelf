ALTER TABLE "goals"."goals" ADD COLUMN "archived_at" timestamp with time zone;
--> statement-breakpoint
-- A goal is renamed and archived (RP-23, RP-24), and nothing else moves
-- through this door: `user_id`, `horizon` and `created_at` carry no grant
-- here or anywhere else, so `renameGoal` and `archiveGoal`/`reopenGoal`
-- (`app/actions/plan.ts`) can only ever touch these two columns, on the
-- caller's own row — `goals_update_self`'s own `using`/`with check` already
-- narrows that (docs/TRAPS.md, "Drizzle's insert builder names every
-- column" does not apply here: drizzle's `.update().set({...})` names only
-- the columns actually passed to `set`, never the whole row the way
-- `.insert()` does).
GRANT UPDATE (name, archived_at) ON TABLE "goals"."goals" TO "authenticated";