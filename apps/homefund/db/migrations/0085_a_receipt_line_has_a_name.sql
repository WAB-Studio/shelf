ALTER TABLE "finances"."transaction_splits" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "finances"."transaction_splits" ADD CONSTRAINT "transaction_splits_description_length" CHECK (char_length("finances"."transaction_splits"."description") <= 200);--> statement-breakpoint
GRANT INSERT (description), UPDATE (description) ON TABLE "finances"."transaction_splits" TO authenticated;
