ALTER POLICY "phases_insert_self" ON "goals"."phases" TO authenticated WITH CHECK ((select auth.uid()) = "goals"."phases"."user_id" and exists (
        select 1 from "goals"."goals" g where g.id = "goals"."phases"."goal_id"
      ));--> statement-breakpoint
ALTER POLICY "one_offs_insert_self" ON "goals"."one_offs" TO authenticated WITH CHECK ((select auth.uid()) = "goals"."one_offs"."user_id" and ("goals"."one_offs"."goal_id" is null or exists (
        select 1 from "goals"."goals" g where g.id = "goals"."one_offs"."goal_id"
      )) and ("goals"."one_offs"."parent_id" is null or exists (
        select 1 from "goals"."one_offs" p
        where p.id = "goals"."one_offs"."parent_id" and p.parent_id is null and p.in_plan
          and p.day is null and p.estimate is null and p.goal_id = "goals"."one_offs"."goal_id"
          and not exists (select 1 from "goals"."facts" f where f.one_off_id = p.id)
      )));--> statement-breakpoint
ALTER POLICY "facts_insert_self" ON "goals"."facts" TO authenticated WITH CHECK ((select auth.uid()) = "goals"."facts"."user_id" and ("goals"."facts"."one_off_id" is null or not exists (
        select 1 from "goals"."one_offs" c where c.parent_id = "goals"."facts"."one_off_id"
      )) and ("goals"."facts"."commitment_id" is null or exists (
        select 1 from "goals"."commitments" cm where cm.id = "goals"."facts"."commitment_id"
      )) and ("goals"."facts"."one_off_id" is null or exists (
        select 1 from "goals"."one_offs" o where o.id = "goals"."facts"."one_off_id"
      )) and ("goals"."facts"."goal_id" is null or exists (
        select 1 from "goals"."goals" g where g.id = "goals"."facts"."goal_id"
      )));--> statement-breakpoint
ALTER POLICY "month_budgets_insert_self" ON "goals"."month_budgets" TO authenticated WITH CHECK ((select auth.uid()) = "goals"."month_budgets"."user_id" and exists (
        select 1 from "goals"."goals" g where g.id = "goals"."month_budgets"."goal_id"
      ));