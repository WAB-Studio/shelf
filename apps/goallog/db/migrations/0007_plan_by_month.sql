CREATE TABLE "goals"."month_budgets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"goal_id" uuid NOT NULL,
	"month" date NOT NULL,
	"amount" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "month_budgets_goal_id_month_unique" UNIQUE("goal_id","month"),
	CONSTRAINT "month_budgets_month_first_day" CHECK ("goals"."month_budgets"."month" = date_trunc('month', "goals"."month_budgets"."month")::date),
	CONSTRAINT "month_budgets_amount_range" CHECK ("goals"."month_budgets"."amount" between 0 and 1000000)
);
--> statement-breakpoint
ALTER TABLE "goals"."month_budgets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "goals"."month_shifts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"goal_id" uuid NOT NULL,
	"month" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "month_shifts_goal_id_month_unique" UNIQUE("goal_id","month"),
	CONSTRAINT "month_shifts_month_first_day" CHECK ("goals"."month_shifts"."month" = date_trunc('month', "goals"."month_shifts"."month")::date)
);
--> statement-breakpoint
ALTER TABLE "goals"."month_shifts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "goals"."model_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"day" date DEFAULT (now() at time zone 'America/Bogota')::date NOT NULL,
	"called_at" timestamp with time zone DEFAULT now() NOT NULL,
	"model" text NOT NULL,
	"source" text NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"outcome" text,
	CONSTRAINT "model_calls_source_known" CHECK ("goals"."model_calls"."source" in ('paste', 'file')),
	CONSTRAINT "model_calls_input_tokens_non_negative" CHECK ("goals"."model_calls"."input_tokens" >= 0),
	CONSTRAINT "model_calls_output_tokens_non_negative" CHECK ("goals"."model_calls"."output_tokens" >= 0),
	CONSTRAINT "model_calls_outcome_known" CHECK ("goals"."model_calls"."outcome" is null or "goals"."model_calls"."outcome" in ('ok', 'failed', 'invalid', 'empty'))
);
--> statement-breakpoint
ALTER TABLE "goals"."model_calls" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "goals"."one_offs" ADD COLUMN "estimate" integer;--> statement-breakpoint
ALTER TABLE "goals"."one_offs" ADD COLUMN "planned_month" date;--> statement-breakpoint
ALTER TABLE "goals"."one_offs" ADD COLUMN "parent_id" uuid;--> statement-breakpoint
ALTER TABLE "goals"."month_budgets" ADD CONSTRAINT "month_budgets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goals"."month_budgets" ADD CONSTRAINT "month_budgets_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "goals"."goals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goals"."month_shifts" ADD CONSTRAINT "month_shifts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goals"."month_shifts" ADD CONSTRAINT "month_shifts_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "goals"."goals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goals"."model_calls" ADD CONSTRAINT "model_calls_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "model_calls_user_id_day_idx" ON "goals"."model_calls" USING btree ("user_id","day");--> statement-breakpoint
ALTER TABLE "goals"."one_offs" ADD CONSTRAINT "one_offs_parent_id_one_offs_id_fk" FOREIGN KEY ("parent_id") REFERENCES "goals"."one_offs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goals"."one_offs" ADD CONSTRAINT "one_offs_estimate_range" CHECK ("goals"."one_offs"."estimate" between 1 and 1000000);--> statement-breakpoint
ALTER TABLE "goals"."one_offs" ADD CONSTRAINT "one_offs_planned_month_first_day" CHECK ("goals"."one_offs"."planned_month" = date_trunc('month', "goals"."one_offs"."planned_month")::date);--> statement-breakpoint
ALTER TABLE "goals"."one_offs" ADD CONSTRAINT "one_offs_planned_month_needs_goal" CHECK ("goals"."one_offs"."planned_month" is null or "goals"."one_offs"."goal_id" is not null);--> statement-breakpoint
ALTER TABLE "goals"."one_offs" ADD CONSTRAINT "one_offs_estimate_needs_goal" CHECK ("goals"."one_offs"."estimate" is null or "goals"."one_offs"."goal_id" is not null);--> statement-breakpoint
ALTER TABLE "goals"."one_offs" ADD CONSTRAINT "one_offs_child_has_no_month" CHECK ("goals"."one_offs"."parent_id" is null or "goals"."one_offs"."planned_month" is null);--> statement-breakpoint
ALTER TABLE "goals"."one_offs" ADD CONSTRAINT "one_offs_not_own_parent" CHECK ("goals"."one_offs"."parent_id" <> "goals"."one_offs"."id");--> statement-breakpoint
CREATE POLICY "month_budgets_select_self" ON "goals"."month_budgets" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((select auth.uid()) = "goals"."month_budgets"."user_id");--> statement-breakpoint
CREATE POLICY "month_budgets_insert_self" ON "goals"."month_budgets" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ((select auth.uid()) = "goals"."month_budgets"."user_id");--> statement-breakpoint
CREATE POLICY "month_budgets_update_self" ON "goals"."month_budgets" AS PERMISSIVE FOR UPDATE TO "authenticated" USING ((select auth.uid()) = "goals"."month_budgets"."user_id") WITH CHECK ((select auth.uid()) = "goals"."month_budgets"."user_id");--> statement-breakpoint
CREATE POLICY "month_budgets_delete_self" ON "goals"."month_budgets" AS PERMISSIVE FOR DELETE TO "authenticated" USING ((select auth.uid()) = "goals"."month_budgets"."user_id");--> statement-breakpoint
CREATE POLICY "month_shifts_select_self" ON "goals"."month_shifts" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((select auth.uid()) = "goals"."month_shifts"."user_id");--> statement-breakpoint
CREATE POLICY "month_shifts_insert_self" ON "goals"."month_shifts" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ((select auth.uid()) = "goals"."month_shifts"."user_id");--> statement-breakpoint
CREATE POLICY "model_calls_select_self" ON "goals"."model_calls" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((select auth.uid()) = "goals"."model_calls"."user_id");--> statement-breakpoint
CREATE POLICY "model_calls_insert_self" ON "goals"."model_calls" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ((select auth.uid()) = "goals"."model_calls"."user_id");--> statement-breakpoint
CREATE POLICY "model_calls_update_self" ON "goals"."model_calls" AS PERMISSIVE FOR UPDATE TO "authenticated" USING ((select auth.uid()) = "goals"."model_calls"."user_id") WITH CHECK ((select auth.uid()) = "goals"."model_calls"."user_id");--> statement-breakpoint
ALTER POLICY "one_offs_select_self" ON "goals"."one_offs" TO authenticated USING (auth.uid() = "goals"."one_offs"."user_id");--> statement-breakpoint
ALTER POLICY "one_offs_insert_self" ON "goals"."one_offs" TO authenticated WITH CHECK ((select auth.uid()) = "goals"."one_offs"."user_id" and ("goals"."one_offs"."parent_id" is null or exists (
        select 1 from "goals"."one_offs" p
        where p.id = "goals"."one_offs"."parent_id" and p.parent_id is null and p.planned_month is not null
          and p.day is null and p.estimate is null and p.goal_id = "goals"."one_offs"."goal_id"
          and not exists (select 1 from "goals"."facts" f where f.one_off_id = p.id)
      )));--> statement-breakpoint
ALTER POLICY "one_offs_delete_self" ON "goals"."one_offs" TO authenticated USING ((select auth.uid()) = "goals"."one_offs"."user_id" and not exists (
        select 1 from "goals"."facts" f where f.one_off_id = "goals"."one_offs"."id"
      ) and not exists (
        select 1 from "goals"."one_offs" c join "goals"."facts" f on f.one_off_id = c.id
        where c.parent_id = "goals"."one_offs"."id"
      ));--> statement-breakpoint
ALTER POLICY "one_offs_update_self" ON "goals"."one_offs" TO authenticated USING ((select auth.uid()) = "goals"."one_offs"."user_id" and ("goals"."one_offs"."day" is null or "goals"."one_offs"."day" > (now() at time zone 'America/Bogota')::date) and not exists (
        select 1 from "goals"."facts" f where f.one_off_id = "goals"."one_offs"."id"
      )) WITH CHECK ((select auth.uid()) = "goals"."one_offs"."user_id" and ("goals"."one_offs"."day" is null or not exists (
        select 1 from "goals"."one_offs" c where c.parent_id = "goals"."one_offs"."id"
      )));--> statement-breakpoint
ALTER POLICY "facts_insert_self" ON "goals"."facts" TO authenticated WITH CHECK ((select auth.uid()) = "goals"."facts"."user_id" and ("goals"."facts"."one_off_id" is null or not exists (
        select 1 from "goals"."one_offs" c where c.parent_id = "goals"."facts"."one_off_id"
      )));--> statement-breakpoint
-- drizzle-kit does not diff a GRANT, so everything below is hand-written, the
-- way 0000's is. Each new table starts from nothing, then takes what it needs.
REVOKE ALL ON TABLE "goals"."month_budgets" FROM "anon", "authenticated", "service_role";
--> statement-breakpoint
ALTER TABLE "goals"."month_budgets" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, DELETE ON TABLE "goals"."month_budgets" TO "authenticated";
--> statement-breakpoint
GRANT INSERT (user_id, goal_id, month, amount) ON TABLE "goals"."month_budgets" TO "authenticated";
--> statement-breakpoint
-- A month moves by delete and insert (RP-34), never by an update of `month`.
GRANT UPDATE (amount) ON TABLE "goals"."month_budgets" TO "authenticated";
--> statement-breakpoint
REVOKE ALL ON TABLE "goals"."month_shifts" FROM "anon", "authenticated", "service_role";
--> statement-breakpoint
ALTER TABLE "goals"."month_shifts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- An act, written once: no UPDATE and no DELETE.
GRANT SELECT ON TABLE "goals"."month_shifts" TO "authenticated";
--> statement-breakpoint
GRANT INSERT (user_id, goal_id, month) ON TABLE "goals"."month_shifts" TO "authenticated";
--> statement-breakpoint
REVOKE ALL ON TABLE "goals"."model_calls" FROM "anon", "authenticated", "service_role";
--> statement-breakpoint
ALTER TABLE "goals"."model_calls" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- No DELETE: a person never lowers their own count. `day` is not insertable,
-- so the zone's default writes it and nobody forges it.
GRANT SELECT ON TABLE "goals"."model_calls" TO "authenticated";
--> statement-breakpoint
GRANT INSERT (user_id, model, source) ON TABLE "goals"."model_calls" TO "authenticated";
--> statement-breakpoint
GRANT UPDATE (input_tokens, output_tokens, outcome) ON TABLE "goals"."model_calls" TO "authenticated";
--> statement-breakpoint
-- `estimate` and `parent_id` take no UPDATE grant: written once, like a commitment.
GRANT INSERT (estimate, planned_month, parent_id) ON TABLE "goals"."one_offs" TO "authenticated";
--> statement-breakpoint
GRANT UPDATE (planned_month) ON TABLE "goals"."one_offs" TO "authenticated";
