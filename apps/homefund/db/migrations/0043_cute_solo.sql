-- RF-63: deleting a category — or an account — was refused whenever a learned-memory row trusted it.
-- `set null` nulled `trusted_category_id` while `state` stayed 'trusted', and the check that binds
-- the two, `ingest_merchants_trusted_category_matches_state`, refused the delete with 23514. Proved
-- on the live database before this ran: a category with no movements trusted by one merchant row,
-- and an account with no movements trusted by one counterparty row, each returned 23514.
--
-- Cascade, not a demotion to 'learning': a trusted row's whole content is "this merchant means that
-- category", so with the category gone it carries nothing, and the check stays true by construction
-- instead of by a trigger. `ambiguous` rows never cascade — the same check already forces their
-- trusted column null. `candidate_category_id` and `candidate_account_id` keep `set null`: no check
-- binds them, and `private.remember_ingest_merchant` reads a null candidate as a broken run
-- (`null = p_category_id` is NULL, never true), which restarts the streak instead of promoting.
ALTER TABLE "ingest_merchants" DROP CONSTRAINT "ingest_merchants_trusted_category_id_categories_id_fk";
--> statement-breakpoint
ALTER TABLE "ingest_counterparties" DROP CONSTRAINT "ingest_counterparties_trusted_account_id_accounts_id_fk";
--> statement-breakpoint
ALTER TABLE "ingest_merchants" ADD CONSTRAINT "ingest_merchants_trusted_category_id_categories_id_fk" FOREIGN KEY ("trusted_category_id") REFERENCES "public"."categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingest_counterparties" ADD CONSTRAINT "ingest_counterparties_trusted_account_id_accounts_id_fk" FOREIGN KEY ("trusted_account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;