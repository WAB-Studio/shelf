-- `GRANT UPDATE (name, cash_mode)` has stood on `groups` since the first migration with no UPDATE
-- policy behind it, so a leader's rename answered UPDATE 0 and the group's name was fixed at
-- creation. The grant already bounds the columns; this bounds the row.
CREATE POLICY "groups_update_leader" ON "groups" AS PERMISSIVE FOR UPDATE TO "authenticated" USING ((select private.is_group_leader("groups"."id"))) WITH CHECK ((select private.is_group_leader("groups"."id")));--> statement-breakpoint
-- Supabase's default privileges hand `anon`, `authenticated` and `service_role` `Dxtm` on every
-- table `postgres` creates in `public`. Every table here clears it with an explicit REVOKE ALL, so
-- nothing is exposed today — but the next CREATE TABLE that forgets one gives `authenticated`
-- TRUNCATE, which ignores RLS and fires no row-level trigger: the table empties and `capture_audit`
-- writes not one row (RF-45). Withdrawn at the source so the forgotten revoke costs nothing.
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated, service_role;--> statement-breakpoint
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated, service_role;--> statement-breakpoint
alter default privileges for role postgres in schema public revoke all on functions from anon, authenticated, service_role;--> statement-breakpoint
-- `goal_progress` revoked from `public, anon, service_role` and left `authenticated` out, so the
-- caller kept the `Dxtm` above on top of the SELECT the view exists for. `account_balances`, cut a
-- migration earlier, names all four. This is the slip, not the policy.
revoke all on public.goal_progress from authenticated;--> statement-breakpoint
grant select on public.goal_progress to authenticated;--> statement-breakpoint
-- The one table-wide INSERT in the schema. `id`, `archived_at` and the timestamps belong to the
-- defaults and the triggers, as they do everywhere else.
revoke insert on table "group_members" from authenticated;--> statement-breakpoint
grant insert (group_id, user_id, name, role, invite_email, external_ref) on table "group_members" to authenticated;--> statement-breakpoint
-- `app_users` granted INSERT and UPDATE table-wide and carried no timestamp trigger, so a caller
-- forged when their own row was born and last changed. The trigger stamps both from now on, which
-- is why `updated_at` leaves the UPDATE grant with nothing lost.
revoke insert, update on table "app_users" from authenticated;--> statement-breakpoint
grant insert (id, locale), update (locale) on table "app_users" to authenticated;--> statement-breakpoint
CREATE TRIGGER app_users_set_timestamps BEFORE INSERT OR UPDATE ON "app_users"
  FOR EACH ROW EXECUTE FUNCTION private.set_row_timestamps();
