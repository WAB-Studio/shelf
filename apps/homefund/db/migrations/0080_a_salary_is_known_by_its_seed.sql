ALTER TABLE "finances"."categories" ADD COLUMN "seed_key" text;--> statement-breakpoint
ALTER TABLE "finances"."categories" ADD CONSTRAINT "categories_seed_key_valid" CHECK ("finances"."categories"."seed_key" in ('salary'));
--> statement-breakpoint
GRANT INSERT (seed_key) ON TABLE "finances"."categories" TO authenticated;--> statement-breakpoint
-- The categories the seeders wrote before the key existed, found by the names they were seeded under.
UPDATE "finances"."categories" SET "seed_key" = 'salary'
  WHERE "parent_id" IS NULL AND "kind" = 'income' AND "name" IN ('Salario', 'Salary');
