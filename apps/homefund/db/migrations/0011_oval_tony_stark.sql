ALTER TABLE "group_members" ADD COLUMN "external_ref" text;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "external_ref" text;--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN "external_ref" text;--> statement-breakpoint
ALTER TABLE "recurring_rules" ADD COLUMN "external_ref" text;--> statement-breakpoint
CREATE UNIQUE INDEX "group_members_group_external_ref_unique" ON "group_members" USING btree ("group_id","external_ref") WHERE "group_members"."external_ref" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_owner_external_ref_unique" ON "accounts" USING btree ("owner_user_id","external_ref") WHERE "accounts"."external_ref" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_group_external_ref_unique" ON "accounts" USING btree ("group_id","external_ref") WHERE "accounts"."external_ref" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "categories_owner_external_ref_unique" ON "categories" USING btree ("owner_user_id","external_ref") WHERE "categories"."external_ref" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "categories_group_external_ref_unique" ON "categories" USING btree ("group_id","external_ref") WHERE "categories"."external_ref" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "recurring_rules_owner_external_ref_unique" ON "recurring_rules" USING btree ("owner_user_id","external_ref") WHERE "recurring_rules"."external_ref" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "recurring_rules_group_external_ref_unique" ON "recurring_rules" USING btree ("group_id","external_ref") WHERE "recurring_rules"."external_ref" is not null;--> statement-breakpoint
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_external_ref_length" CHECK (length("group_members"."external_ref") <= 200);--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_external_ref_length" CHECK (length("accounts"."external_ref") <= 200);--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_external_ref_length" CHECK (length("categories"."external_ref") <= 200);--> statement-breakpoint
ALTER TABLE "recurring_rules" ADD CONSTRAINT "recurring_rules_external_ref_length" CHECK (length("recurring_rules"."external_ref") <= 200);--> statement-breakpoint
-- Seed every existing row with its own id as the key, so a re-import round-trips to the same row (RF-51).
-- The `is null` guard leaves a webhook-provided ref (RF-85) that already reached transactions untouched.
UPDATE "accounts" SET "external_ref" = "id"::text WHERE "external_ref" IS NULL;--> statement-breakpoint
UPDATE "categories" SET "external_ref" = "id"::text WHERE "external_ref" IS NULL;--> statement-breakpoint
UPDATE "recurring_rules" SET "external_ref" = "id"::text WHERE "external_ref" IS NULL;--> statement-breakpoint
UPDATE "group_members" SET "external_ref" = "id"::text WHERE "external_ref" IS NULL;--> statement-breakpoint
UPDATE "transactions" SET "external_ref" = "id"::text WHERE "external_ref" IS NULL;--> statement-breakpoint
-- One generic derive across the five entities: it reads only `new.id`/`new.external_ref`, both present
-- on all five. The `WHEN (new.external_ref IS NULL)` guard on each trigger keeps an explicit value —
-- an import upsert key or an RF-85 webhook delivery — so the function only ever fills an omitted one.
-- Owner-run like 0009's `set_account_subtype`, so no caller role can redefine or invoke it directly.
create or replace function private.set_external_ref() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.external_ref := new.id::text;
  return new;
end;
$$;
revoke all on function private.set_external_ref() from public, anon, authenticated, service_role;--> statement-breakpoint
CREATE TRIGGER accounts_set_external_ref BEFORE INSERT ON "accounts"
  FOR EACH ROW WHEN (new.external_ref IS NULL) EXECUTE FUNCTION private.set_external_ref();--> statement-breakpoint
CREATE TRIGGER categories_set_external_ref BEFORE INSERT ON "categories"
  FOR EACH ROW WHEN (new.external_ref IS NULL) EXECUTE FUNCTION private.set_external_ref();--> statement-breakpoint
CREATE TRIGGER recurring_rules_set_external_ref BEFORE INSERT ON "recurring_rules"
  FOR EACH ROW WHEN (new.external_ref IS NULL) EXECUTE FUNCTION private.set_external_ref();--> statement-breakpoint
CREATE TRIGGER group_members_set_external_ref BEFORE INSERT ON "group_members"
  FOR EACH ROW WHEN (new.external_ref IS NULL) EXECUTE FUNCTION private.set_external_ref();--> statement-breakpoint
CREATE TRIGGER transactions_set_external_ref BEFORE INSERT ON "transactions"
  FOR EACH ROW WHEN (new.external_ref IS NULL) EXECUTE FUNCTION private.set_external_ref();--> statement-breakpoint
-- Column-scoped writes so the import can stamp the key under RLS: the row-bounding policies still decide
-- which rows, this grant only opens the one column. Mirrors 0009's subtype grant; transactions already
-- grants what it needs. No table is created here, so the REVOKE-ALL-on-CREATE rule does not apply.
GRANT INSERT (external_ref), UPDATE (external_ref) ON TABLE "accounts" TO authenticated;--> statement-breakpoint
GRANT INSERT (external_ref), UPDATE (external_ref) ON TABLE "categories" TO authenticated;--> statement-breakpoint
GRANT INSERT (external_ref), UPDATE (external_ref) ON TABLE "recurring_rules" TO authenticated;--> statement-breakpoint
GRANT INSERT (external_ref), UPDATE (external_ref) ON TABLE "group_members" TO authenticated;