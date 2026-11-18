ALTER TABLE "finances"."debt_terms" ADD COLUMN "term_months" smallint;--> statement-breakpoint
ALTER TABLE "finances"."debt_terms" ADD CONSTRAINT "debt_terms_term_months_valid" CHECK ("finances"."debt_terms"."term_months" is null or "finances"."debt_terms"."term_months" between 1 and 600);--> statement-breakpoint
-- RF-286, hand-written: drizzle-kit diffs no grant. The table grants its columns one by one, so the new one is
-- granted on insert and update like the profile's other fields.
GRANT INSERT (term_months) ON TABLE "finances"."debt_terms" TO authenticated;--> statement-breakpoint
GRANT UPDATE (term_months) ON TABLE "finances"."debt_terms" TO authenticated;
