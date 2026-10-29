CREATE SCHEMA "finances";
--> statement-breakpoint
ALTER TABLE "public"."account_statements" SET SCHEMA "finances";
--> statement-breakpoint
ALTER TABLE "public"."accounts" SET SCHEMA "finances";
--> statement-breakpoint
ALTER TABLE "public"."app_users" SET SCHEMA "finances";
--> statement-breakpoint
ALTER TABLE "public"."audit_log" SET SCHEMA "finances";
--> statement-breakpoint
ALTER TABLE "public"."budgets" SET SCHEMA "finances";
--> statement-breakpoint
ALTER TABLE "public"."categories" SET SCHEMA "finances";
--> statement-breakpoint
ALTER TABLE "public"."debt_terms" SET SCHEMA "finances";
--> statement-breakpoint
ALTER TABLE "public"."goal_contributions" SET SCHEMA "finances";
--> statement-breakpoint
ALTER TABLE "public"."group_members" SET SCHEMA "finances";
--> statement-breakpoint
ALTER TABLE "public"."groups" SET SCHEMA "finances";
--> statement-breakpoint
ALTER TABLE "public"."ingest_counterparties" SET SCHEMA "finances";
--> statement-breakpoint
ALTER TABLE "public"."ingest_deliveries" SET SCHEMA "finances";
--> statement-breakpoint
ALTER TABLE "public"."ingest_merchants" SET SCHEMA "finances";
--> statement-breakpoint
ALTER TABLE "public"."ingest_shapes" SET SCHEMA "finances";
--> statement-breakpoint
ALTER TABLE "public"."installment_lines" SET SCHEMA "finances";
--> statement-breakpoint
ALTER TABLE "public"."installment_plans" SET SCHEMA "finances";
--> statement-breakpoint
ALTER TABLE "public"."labels" SET SCHEMA "finances";
--> statement-breakpoint
ALTER TABLE "public"."planned_payments" SET SCHEMA "finances";
--> statement-breakpoint
ALTER TABLE "public"."recurring_rules" SET SCHEMA "finances";
--> statement-breakpoint
ALTER TABLE "public"."savings_goals" SET SCHEMA "finances";
--> statement-breakpoint
ALTER TABLE "public"."transaction_labels" SET SCHEMA "finances";
--> statement-breakpoint
ALTER TABLE "public"."transaction_splits" SET SCHEMA "finances";
--> statement-breakpoint
ALTER TABLE "public"."transactions" SET SCHEMA "finances";
--> statement-breakpoint
ALTER TABLE "public"."webhook_credentials" SET SCHEMA "finances";
--> statement-breakpoint
ALTER VIEW "public"."account_balances" SET SCHEMA "finances";
--> statement-breakpoint
ALTER VIEW "public"."goal_progress" SET SCHEMA "finances";
--> statement-breakpoint
REVOKE ALL ON SCHEMA "finances" FROM "anon", "authenticated", "service_role";
--> statement-breakpoint
GRANT USAGE ON SCHEMA "finances" TO "authenticated";
--> statement-breakpoint
ALTER ROLE "authenticated" SET search_path = finances, public;
