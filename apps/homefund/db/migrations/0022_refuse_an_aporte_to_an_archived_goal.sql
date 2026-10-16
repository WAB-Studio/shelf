-- `goal_contributions_insert_member` asked who owns the goal and never whether it was still open, so
-- an aporte landed on an archived goal and moved a progress a person had already put away (RF-120).
-- The Aportar button went away one commit earlier, which left the client as the sole guard — the
-- pattern this schema refuses. The predicate is on the INSERT alone: a delete still reaches an
-- archived goal's aportes, and no existing row is re-checked. No live row is affected — 0 aportes
-- sit on an archived goal at the time of writing.
ALTER POLICY "goal_contributions_insert_member" ON "goal_contributions" TO authenticated WITH CHECK (exists (select 1 from "savings_goals" g where g.id = "goal_contributions"."goal_id" and g.archived_at is null and (g.owner_user_id = (select auth.uid()) or private.is_group_member(g.group_id))));