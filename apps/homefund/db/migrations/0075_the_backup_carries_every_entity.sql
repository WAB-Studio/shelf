ALTER TABLE "finances"."labels" ADD COLUMN "external_ref" text;--> statement-breakpoint
ALTER TABLE "finances"."budgets" ADD COLUMN "external_ref" text;--> statement-breakpoint
ALTER TABLE "finances"."savings_goals" ADD COLUMN "external_ref" text;--> statement-breakpoint
ALTER TABLE "finances"."goal_contributions" ADD COLUMN "external_ref" text;--> statement-breakpoint
CREATE UNIQUE INDEX "labels_owner_external_ref_unique" ON "finances"."labels" USING btree ("owner_user_id","external_ref") WHERE "finances"."labels"."external_ref" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "labels_group_external_ref_unique" ON "finances"."labels" USING btree ("group_id","external_ref") WHERE "finances"."labels"."external_ref" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "budgets_owner_external_ref_unique" ON "finances"."budgets" USING btree ("owner_user_id","external_ref") WHERE "finances"."budgets"."external_ref" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "budgets_group_external_ref_unique" ON "finances"."budgets" USING btree ("group_id","external_ref") WHERE "finances"."budgets"."external_ref" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "savings_goals_owner_external_ref_unique" ON "finances"."savings_goals" USING btree ("owner_user_id","external_ref") WHERE "finances"."savings_goals"."external_ref" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "savings_goals_group_external_ref_unique" ON "finances"."savings_goals" USING btree ("group_id","external_ref") WHERE "finances"."savings_goals"."external_ref" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "goal_contributions_goal_external_ref_unique" ON "finances"."goal_contributions" USING btree ("goal_id","external_ref") WHERE "finances"."goal_contributions"."external_ref" is not null;--> statement-breakpoint
ALTER TABLE "finances"."labels" ADD CONSTRAINT "labels_external_ref_length" CHECK (length("finances"."labels"."external_ref") <= 200);--> statement-breakpoint
ALTER TABLE "finances"."budgets" ADD CONSTRAINT "budgets_external_ref_length" CHECK (length("finances"."budgets"."external_ref") <= 200);--> statement-breakpoint
ALTER TABLE "finances"."savings_goals" ADD CONSTRAINT "savings_goals_external_ref_length" CHECK (length("finances"."savings_goals"."external_ref") <= 200);--> statement-breakpoint
ALTER TABLE "finances"."goal_contributions" ADD CONSTRAINT "goal_contributions_external_ref_length" CHECK (length("finances"."goal_contributions"."external_ref") <= 200);--> statement-breakpoint
-- RF-142: every row the backup carries keeps a stable key, so a re-import updates instead of duplicating (RF-52).
UPDATE "finances"."labels" SET "external_ref" = "id"::text WHERE "external_ref" IS NULL;--> statement-breakpoint
UPDATE "finances"."budgets" SET "external_ref" = "id"::text WHERE "external_ref" IS NULL;--> statement-breakpoint
UPDATE "finances"."savings_goals" SET "external_ref" = "id"::text WHERE "external_ref" IS NULL;--> statement-breakpoint
UPDATE "finances"."goal_contributions" SET "external_ref" = "id"::text WHERE "external_ref" IS NULL;--> statement-breakpoint
CREATE TRIGGER labels_set_external_ref BEFORE INSERT ON "finances"."labels"
  FOR EACH ROW WHEN (new.external_ref IS NULL) EXECUTE FUNCTION private.set_external_ref();--> statement-breakpoint
CREATE TRIGGER budgets_set_external_ref BEFORE INSERT ON "finances"."budgets"
  FOR EACH ROW WHEN (new.external_ref IS NULL) EXECUTE FUNCTION private.set_external_ref();--> statement-breakpoint
CREATE TRIGGER savings_goals_set_external_ref BEFORE INSERT ON "finances"."savings_goals"
  FOR EACH ROW WHEN (new.external_ref IS NULL) EXECUTE FUNCTION private.set_external_ref();--> statement-breakpoint
CREATE TRIGGER goal_contributions_set_external_ref BEFORE INSERT ON "finances"."goal_contributions"
  FOR EACH ROW WHEN (new.external_ref IS NULL) EXECUTE FUNCTION private.set_external_ref();--> statement-breakpoint
GRANT INSERT (external_ref) ON TABLE "finances"."labels" TO authenticated;--> statement-breakpoint
GRANT INSERT (external_ref) ON TABLE "finances"."budgets" TO authenticated;--> statement-breakpoint
GRANT INSERT (external_ref) ON TABLE "finances"."savings_goals" TO authenticated;--> statement-breakpoint
-- A restored contribution keeps the day it was set aside (RF-119 lists it by that day).
GRANT INSERT (external_ref, created_at) ON TABLE "finances"."goal_contributions" TO authenticated;
