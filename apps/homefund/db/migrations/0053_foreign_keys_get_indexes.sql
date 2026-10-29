CREATE INDEX "transactions_created_by_recent_idx" ON "finances"."transactions" USING btree ("created_by","occurred_at" DESC NULLS LAST,"created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "transactions_recent_idx" ON "finances"."transactions" USING btree ("occurred_at" DESC NULLS LAST,"created_at" DESC NULLS LAST,"id");--> statement-breakpoint
CREATE INDEX "transactions_unreviewed_generated_idx" ON "finances"."transactions" USING btree ("id") WHERE "finances"."transactions"."recurring_rule_id" is not null and "finances"."transactions"."reviewed_at" is null;--> statement-breakpoint
CREATE INDEX "budgets_account_id_idx" ON "finances"."budgets" USING btree ("account_id") WHERE "finances"."budgets"."account_id" is not null;--> statement-breakpoint
CREATE INDEX "budgets_label_id_idx" ON "finances"."budgets" USING btree ("label_id") WHERE "finances"."budgets"."label_id" is not null;--> statement-breakpoint
CREATE INDEX "planned_payments_from_account_id_idx" ON "finances"."planned_payments" USING btree ("from_account_id") WHERE "finances"."planned_payments"."from_account_id" is not null;--> statement-breakpoint
CREATE INDEX "planned_payments_to_account_id_idx" ON "finances"."planned_payments" USING btree ("to_account_id") WHERE "finances"."planned_payments"."to_account_id" is not null;--> statement-breakpoint
CREATE INDEX "planned_payments_category_id_idx" ON "finances"."planned_payments" USING btree ("category_id") WHERE "finances"."planned_payments"."category_id" is not null;--> statement-breakpoint
CREATE INDEX "planned_payments_created_by_idx" ON "finances"."planned_payments" USING btree ("created_by") WHERE "finances"."planned_payments"."created_by" is not null;--> statement-breakpoint
CREATE INDEX "recurring_rules_from_account_id_idx" ON "finances"."recurring_rules" USING btree ("from_account_id") WHERE "finances"."recurring_rules"."from_account_id" is not null;--> statement-breakpoint
CREATE INDEX "recurring_rules_to_account_id_idx" ON "finances"."recurring_rules" USING btree ("to_account_id") WHERE "finances"."recurring_rules"."to_account_id" is not null;--> statement-breakpoint
CREATE INDEX "recurring_rules_created_by_idx" ON "finances"."recurring_rules" USING btree ("created_by") WHERE "finances"."recurring_rules"."created_by" is not null;--> statement-breakpoint
CREATE INDEX "savings_goals_account_id_idx" ON "finances"."savings_goals" USING btree ("account_id") WHERE "finances"."savings_goals"."account_id" is not null;--> statement-breakpoint
CREATE INDEX "transaction_sources_statement_id_idx" ON "finances"."transaction_sources" USING btree ("statement_id") WHERE "finances"."transaction_sources"."statement_id" is not null;--> statement-breakpoint
CREATE INDEX "webhook_credentials_default_account_id_idx" ON "finances"."webhook_credentials" USING btree ("default_account_id") WHERE "finances"."webhook_credentials"."default_account_id" is not null;--> statement-breakpoint
CREATE INDEX "webhook_credentials_default_category_id_idx" ON "finances"."webhook_credentials" USING btree ("default_category_id") WHERE "finances"."webhook_credentials"."default_category_id" is not null;--> statement-breakpoint
CREATE INDEX "ingest_deliveries_transaction_id_idx" ON "finances"."ingest_deliveries" USING btree ("transaction_id") WHERE "finances"."ingest_deliveries"."transaction_id" is not null;--> statement-breakpoint
CREATE INDEX "ingest_deliveries_credential_id_idx" ON "finances"."ingest_deliveries" USING btree ("credential_id") WHERE "finances"."ingest_deliveries"."credential_id" is not null;--> statement-breakpoint
CREATE INDEX "ingest_deliveries_proposed_account_id_idx" ON "finances"."ingest_deliveries" USING btree ("proposed_account_id") WHERE "finances"."ingest_deliveries"."proposed_account_id" is not null;--> statement-breakpoint
CREATE INDEX "ingest_deliveries_proposed_category_id_idx" ON "finances"."ingest_deliveries" USING btree ("proposed_category_id") WHERE "finances"."ingest_deliveries"."proposed_category_id" is not null;--> statement-breakpoint
CREATE INDEX "ingest_merchants_candidate_category_id_idx" ON "finances"."ingest_merchants" USING btree ("candidate_category_id") WHERE "finances"."ingest_merchants"."candidate_category_id" is not null;--> statement-breakpoint
CREATE INDEX "ingest_merchants_trusted_category_id_idx" ON "finances"."ingest_merchants" USING btree ("trusted_category_id") WHERE "finances"."ingest_merchants"."trusted_category_id" is not null;--> statement-breakpoint
CREATE INDEX "ingest_counterparties_candidate_account_id_idx" ON "finances"."ingest_counterparties" USING btree ("candidate_account_id") WHERE "finances"."ingest_counterparties"."candidate_account_id" is not null;--> statement-breakpoint
CREATE INDEX "ingest_counterparties_trusted_account_id_idx" ON "finances"."ingest_counterparties" USING btree ("trusted_account_id") WHERE "finances"."ingest_counterparties"."trusted_account_id" is not null;--> statement-breakpoint
-- The `goals` and `reading` schemas carry this fence; `finances` had only the per-table REVOKE, so
-- a CREATE TABLE that forgot one would have handed `authenticated` TRUNCATE (RF-45).
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA "finances"
  REVOKE ALL ON TABLES FROM anon, authenticated, service_role;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA "finances"
  REVOKE ALL ON SEQUENCES FROM anon, authenticated, service_role;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA "finances"
  REVOKE ALL ON FUNCTIONS FROM anon, authenticated, service_role;
