-- RF-63: a personal subcategory goes with its parent, as a fund one already does through the composite key.
-- Hand-written: the key below cannot land while a subcategory names a parent that is gone, and the composite key's
-- MATCH SIMPLE left such orphans behind every personal delete. An orphan nothing names goes.
DELETE FROM "finances"."categories" c
WHERE c.parent_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "finances"."categories" p WHERE p.id = c.parent_id)
  AND NOT EXISTS (SELECT 1 FROM "finances"."transaction_splits" s WHERE s.category_id = c.id)
  AND NOT EXISTS (SELECT 1 FROM "finances"."budgets" b WHERE b.category_id = c.id)
  AND NOT EXISTS (SELECT 1 FROM "finances"."planned_payments" pp WHERE pp.category_id = c.id)
  AND NOT EXISTS (SELECT 1 FROM "finances"."recurring_rules" r WHERE r.category_id = c.id)
  AND NOT EXISTS (SELECT 1 FROM "finances"."webhook_credentials" w WHERE w.default_category_id = c.id)
  AND NOT EXISTS (SELECT 1 FROM "finances"."ingest_deliveries" d WHERE d.proposed_category_id = c.id)
  AND NOT EXISTS (
    SELECT 1 FROM "finances"."ingest_merchants" m
    WHERE m.candidate_category_id = c.id OR m.trusted_category_id = c.id
  );--> statement-breakpoint
-- An orphan something still names stays, top-level in its own place, so no movement loses its category.
UPDATE "finances"."categories" c
SET parent_id = NULL
WHERE c.parent_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "finances"."categories" p WHERE p.id = c.parent_id);--> statement-breakpoint
ALTER TABLE "finances"."categories" ADD CONSTRAINT "categories_parent_id_categories_id_fk" FOREIGN KEY ("parent_id") REFERENCES "finances"."categories"("id") ON DELETE cascade ON UPDATE no action;
